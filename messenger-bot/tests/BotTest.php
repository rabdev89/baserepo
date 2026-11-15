<?php

declare(strict_types=1);

namespace MessengerBot\Tests;

use MessengerBot\Bot;
use MessengerBot\Brain\BrainReply;
use MessengerBot\Brain\BrainUnavailable;
use MessengerBot\Config;
use MessengerBot\Store\ConversationStore;
use MessengerBot\Webhook\InboundEvent;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/Fakes.php';

final class BotTest extends TestCase
{
    private FakeBrain $brain;
    private FakeMessenger $messenger;
    private ConversationStore $store;
    private Bot $bot;
    private int $n = 0;

    protected function setUp(): void
    {
        $this->brain = new FakeBrain();
        $this->messenger = new FakeMessenger();
        $this->store = new ConversationStore(':memory:');
        $this->bot = new Bot(
            $this->store,
            $this->brain,
            $this->messenger,
            new Config('token', 'secret', 'verify', businessName: 'Acme'),
            log: static fn () => null,
        );
    }

    private function text(string $text, ?string $mid = null): InboundEvent
    {
        return new InboundEvent(InboundEvent::TEXT, 'u1', $mid ?? 'm' . (++$this->n), time() * 1000, $text);
    }

    public function testRepliesWithAiAnswerAndQuickReplies(): void
    {
        $this->brain->queue[] = new BrainReply('We open at 9.', 'opening_hours', 'high', 'neutral', false, ['Address?']);
        $this->bot->handle($this->text('when do you open'));

        self::assertSame('We open at 9.', $this->messenger->sent[0]['text']);
        self::assertSame('Address?', $this->messenger->sent[0]['quick_replies'][0]['title']);
        self::assertContains('typing_on', $this->messenger->actions);
    }

    public function testDuplicateWebhookDeliveryIsProcessedOnce(): void
    {
        $this->bot->handle($this->text('hello', 'same-mid'));
        $this->bot->handle($this->text('hello', 'same-mid'));

        self::assertCount(1, $this->brain->calls);
        self::assertCount(1, $this->messenger->sent);
    }

    public function testRemembersEarlierTurns(): void
    {
        $this->brain->queue[] = new BrainReply('Nice to meet you, Ana.', 'greeting', 'high', 'positive', false);
        $this->bot->handle($this->text('Hi, my name is Ana'));
        $this->bot->handle($this->text('what is my name?'));

        $history = $this->brain->calls[1]['history'];
        self::assertSame('Hi, my name is Ana', $history[0]['content']);
        self::assertSame('assistant', $history[1]['role']);
    }

    public function testAskingForHumanHandsOffWithoutCallingAi(): void
    {
        $this->bot->handle($this->text('I want to talk to a real person'));

        self::assertCount(0, $this->brain->calls);
        self::assertSame(['handoff:user_requested'], $this->messenger->handoffs);
        self::assertStringContainsString('connecting you', $this->messenger->sent[0]['text']);
    }

    public function testBotStaysSilentWhileHumanOwnsThreadAndResumesOnRequest(): void
    {
        $this->bot->handle($this->text('agent please'));
        $sentAfterHandoff = count($this->messenger->sent);

        $this->bot->handle($this->text('hello?'));
        self::assertCount($sentAfterHandoff, $this->messenger->sent, 'bot must not talk over the human');
        self::assertCount(0, $this->brain->calls);

        $this->bot->handle($this->text('bot'));
        self::assertCount(1, $this->brain->calls);
    }

    public function testHandbackEventReEnablesBot(): void
    {
        $this->bot->handle($this->text('human'));
        $this->bot->handle(new InboundEvent(InboundEvent::HANDBACK, 'u1', 'hb1', time() * 1000));
        $this->bot->handle($this->text('thanks, one more question'));

        self::assertCount(1, $this->brain->calls);
    }

    public function testLoopOnSameIntentEscalates(): void
    {
        for ($i = 0; $i < 3; $i++) {
            $this->brain->queue[] = new BrainReply('Your order ships soon.', 'order_status', 'high', 'neutral', false);
            $this->bot->handle($this->text('where is my order'));
        }

        self::assertSame(['handoff:loop'], $this->messenger->handoffs);
    }

    public function testRepeatedLowConfidenceEscalates(): void
    {
        $this->brain->queue[] = new BrainReply("I'm not sure.", 'warranty', 'low', 'neutral', false);
        $this->brain->queue[] = new BrainReply("I'm not sure.", 'gift_cards', 'low', 'neutral', false);
        $this->bot->handle($this->text('warranty?'));
        $this->bot->handle($this->text('gift cards?'));

        self::assertSame(['handoff:strikes'], $this->messenger->handoffs);
    }

    public function testAngryCustomerEscalatesImmediately(): void
    {
        $this->brain->queue[] = new BrainReply('So sorry.', 'complaint', 'high', 'angry', false);
        $this->bot->handle($this->text('this is ridiculous!!!'));

        self::assertSame(['handoff:angry'], $this->messenger->handoffs);
    }

    public function testAiOutageStillAnswersWithEscapeHatch(): void
    {
        $this->brain->queue[] = new BrainUnavailable('rate limited');
        $this->bot->handle($this->text('hi'));

        self::assertStringContainsString('trouble', $this->messenger->sent[0]['text']);
        self::assertSame('Talk to a person', $this->messenger->sent[0]['quick_replies'][0]['title']);
    }

    public function testLongReplyIsSplitUnderMessengerLimit(): void
    {
        $this->brain->queue[] = new BrainReply(str_repeat('This is a sentence. ', 250), 'info', 'high', 'neutral', false, ['More']);
        $this->bot->handle($this->text('tell me everything'));

        self::assertGreaterThan(1, count($this->messenger->sent));
        foreach ($this->messenger->sent as $m) {
            self::assertLessThanOrEqual(2000, mb_strlen($m['text']));
        }
        self::assertSame([], $this->messenger->sent[0]['quick_replies'], 'quick replies only on the last chunk');
        self::assertNotSame([], end($this->messenger->sent)['quick_replies']);
    }

    public function testVoiceNoteGetsHelpfulReplyNotSilence(): void
    {
        $this->bot->handle(new InboundEvent(InboundEvent::UNSUPPORTED_MEDIA, 'u1', 'v1', time() * 1000, '', [], 'audio'));

        self::assertStringContainsString('voice messages', $this->messenger->sent[0]['text']);
        self::assertCount(0, $this->brain->calls);
    }

    public function testImageIsPassedToAi(): void
    {
        $this->bot->handle(new InboundEvent(InboundEvent::IMAGE, 'u1', 'i1', time() * 1000, 'is this broken?', ['https://cdn.example/x.jpg']));

        self::assertSame(['https://cdn.example/x.jpg'], $this->brain->calls[0]['images']);
    }

    public function testGetStartedGreets(): void
    {
        $this->bot->handle(new InboundEvent(InboundEvent::GET_STARTED, 'u1', 'gs1', time() * 1000, 'Get Started'));

        self::assertStringContainsString('Acme', $this->messenger->sent[0]['text']);
        self::assertCount(0, $this->brain->calls);
    }
}
