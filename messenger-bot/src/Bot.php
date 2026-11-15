<?php

declare(strict_types=1);

namespace MessengerBot;

use MessengerBot\Brain\Brain;
use MessengerBot\Brain\BrainUnavailable;
use MessengerBot\Messenger\MessageFormatter;
use MessengerBot\Messenger\Messenger;
use MessengerBot\Policy\EscalationPolicy;
use MessengerBot\Policy\MessagingWindow;
use MessengerBot\Store\ConversationStore;
use MessengerBot\Webhook\InboundEvent;

/**
 * The conversation pipeline. Each step maps to one of the top-10 problems (see README).
 */
final class Bot
{
    private const RESUME_WORDS = '/^\s*(bot|restart|start over|menu)\s*[.!]*\s*$/iu';
    private const HANDOFF_TIMEOUT_SECONDS = 24 * 3600;

    /** @var callable(string): void */
    private $log;

    public function __construct(
        private readonly ConversationStore $store,
        private readonly Brain $brain,
        private readonly Messenger $messenger,
        private readonly Config $config,
        private readonly EscalationPolicy $escalation = new EscalationPolicy(),
        private readonly MessagingWindow $window = new MessagingWindow(),
        private readonly MessageFormatter $formatter = new MessageFormatter(),
        ?callable $log = null,
    ) {
        $this->log = $log ?? static fn (string $m) => error_log('[messenger-bot] ' . $m);
    }

    public function handle(InboundEvent $e): void
    {
        // #7 Meta retries webhooks and can deliver the same event twice. Process each once.
        if (!$this->store->markProcessed($e->eventId)) {
            ($this->log)("duplicate event {$e->eventId} ignored");
            return;
        }

        $psid = $e->psid;

        if ($e->kind === InboundEvent::HANDBACK) {
            $this->store->updateUser($psid, ['handed_off' => 0, 'strikes' => 0, 'intent_streak' => 0]);
            return;
        }

        $user = $this->store->user($psid);
        $history = $this->store->recentMessages($psid);   // #3 memory: earlier turns
        $now = time();

        // #6 Opens/refreshes the 24h window.
        $this->store->updateUser($psid, ['last_user_at' => max($now, intdiv($e->timestampMs, 1000))]);
        $this->store->addMessage($psid, 'user', $this->describeForHistory($e));

        // #1 While a person owns the conversation, the bot stays out of the way.
        if ($user['handed_off'] > 0) {
            $expired = ($now - $user['handed_off']) > self::HANDOFF_TIMEOUT_SECONDS;
            if (!$expired && preg_match(self::RESUME_WORDS, $e->text) !== 1) {
                return;
            }
            $this->store->updateUser($psid, ['handed_off' => 0, 'strikes' => 0, 'intent_streak' => 0]);
            $user = $this->store->user($psid);
        }

        // #8 Show we're alive immediately; AI answers take a few seconds.
        $this->messenger->senderAction($psid, 'mark_seen');
        $this->messenger->senderAction($psid, 'typing_on');

        // #10 Inputs that aren't plain text.
        if ($e->kind === InboundEvent::GET_STARTED) {
            $this->reply($psid, "Hi! 👋 I'm the {$this->config->businessName} assistant. Ask me anything, in any language. If you'd rather talk to a person, just say so.", ['Opening hours', 'Track my order', 'Talk to a person']);
            return;
        }
        if ($e->kind === InboundEvent::UNSUPPORTED_MEDIA) {
            $what = match ($e->mediaType) {
                'audio' => 'voice messages',
                'video' => 'videos',
                'file' => 'files',
                default => 'that kind of attachment',
            };
            $this->reply($psid, "Sorry, I can't open {$what} yet. Could you type your question instead? You can also send a photo.", ['Talk to a person']);
            return;
        }

        // #1 Explicit request for a human: no AI round-trip, no arguing.
        if ($this->escalation->userAskedForHuman($e->text)) {
            $this->handOff($psid, 'user_requested');
            return;
        }

        // #2 #5 Real understanding, grounded in the knowledge base.
        try {
            $answer = $this->brain->think($history, $e->text, $e->imageUrls);
        } catch (BrainUnavailable $ex) {
            // AI outage must never mean silence.
            ($this->log)('brain unavailable: ' . $ex->getMessage());
            $this->reply($psid, "Sorry, I'm having trouble answering right now. Want me to get a person from our team to help?", ['Talk to a person', 'Try again']);
            return;
        }

        // #4 Loop / frustration detection.
        $decision = $this->escalation->evaluate($answer, $user);
        $this->store->updateUser($psid, $decision['state']);

        if ($decision['escalate']) {
            if ($answer->reply !== '' && $decision['reason'] === 'ai_requested') {
                $this->reply($psid, $answer->reply);
            }
            $this->handOff($psid, $decision['reason']);
            return;
        }

        $this->reply($psid, $answer->reply, $answer->quickReplies);
    }

    /** @param list<string> $quickReplies */
    private function reply(string $psid, string $text, array $quickReplies = []): void
    {
        // #6 Never send an automated message outside the 24h window.
        $user = $this->store->user($psid);
        if (!$this->window->isOpen($user['last_user_at'])) {
            ($this->log)("24h window closed for {$psid}; message not sent");
            return;
        }

        // #9 Respect Messenger's size limits.
        $chunks = $this->formatter->splitText($text);
        $qrs = $this->formatter->quickReplies($quickReplies);
        $last = count($chunks) - 1;
        foreach ($chunks as $i => $chunk) {
            try {
                $this->messenger->sendText($psid, $chunk, $i === $last ? $qrs : []);
            } catch (\RuntimeException $ex) {
                ($this->log)('send failed: ' . $ex->getMessage());
                return;
            }
        }
        if ($chunks !== []) {
            $this->store->addMessage($psid, 'assistant', implode("\n\n", $chunks));
        }
    }

    private function handOff(string $psid, string $reason): void
    {
        $this->reply(
            $psid,
            "I'm connecting you with someone from our team. They'll reply right here {$this->config->humanReplyEta}. "
            . "You don't need to repeat anything; they can see this chat. (Type \"bot\" anytime to come back to me.)"
        );

        try {
            $this->messenger->passThreadControl($psid, $this->config->humanInboxAppId, "handoff:{$reason}");
        } catch (\RuntimeException $ex) {
            // Messages still appear in the Page Inbox, so the team can reply even if the handover call fails.
            ($this->log)('pass_thread_control failed: ' . $ex->getMessage());
        }

        $this->store->updateUser($psid, ['handed_off' => time(), 'strikes' => 0, 'intent_streak' => 0]);
        ($this->log)("handed off {$psid} ({$reason})");
    }

    private function describeForHistory(InboundEvent $e): string
    {
        return match ($e->kind) {
            InboundEvent::IMAGE => trim('[sent a photo] ' . $e->text),
            InboundEvent::UNSUPPORTED_MEDIA => "[sent a {$e->mediaType} attachment]",
            InboundEvent::GET_STARTED => '[tapped Get Started]',
            default => $e->text,
        };
    }
}
