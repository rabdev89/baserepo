<?php

declare(strict_types=1);

namespace MessengerBot\Policy;

use MessengerBot\Brain\BrainReply;

/**
 * Fixes problems #1 (no way to reach a human) and #4 (bot loops / canned answers).
 *
 * Escalates when:
 *  - the user explicitly asks for a person (checked before the AI is even called)
 *  - the AI says a human is needed
 *  - the user is angry
 *  - the user asks about the same thing 3 times in a row (the bot is looping)
 *  - 2 "strikes" pile up (frustrated sentiment or low-confidence answers)
 */
final class EscalationPolicy
{
    public const MAX_SAME_INTENT = 3;
    public const MAX_STRIKES = 2;

    private const HUMAN_PATTERNS = [
        '/\b(human|person|real person|agent|representative|operator|someone real|live chat|customer service|talk to (a|an|some)one|speak to (a|an|some)one)\b/iu',
        '/\b(tao|totoong tao|ahente|persona|humano|agente|mensch|mitarbeiter|humain|conseiller)\b/iu',
    ];

    public function userAskedForHuman(string $text): bool
    {
        foreach (self::HUMAN_PATTERNS as $pattern) {
            if (preg_match($pattern, $text) === 1) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param array{last_intent: string, intent_streak: int, strikes: int} $user
     * @return array{escalate: bool, reason: string, state: array{last_intent: string, intent_streak: int, strikes: int}}
     */
    public function evaluate(BrainReply $reply, array $user): array
    {
        $streak = ($reply->intent !== '' && $reply->intent === $user['last_intent'] && $reply->intent !== 'greeting' && $reply->intent !== 'thanks')
            ? $user['intent_streak'] + 1
            : 1;

        $strikes = $user['strikes'];
        if (in_array($reply->sentiment, ['frustrated', 'angry'], true)) {
            $strikes++;
        }
        if ($reply->confidence === 'low') {
            $strikes++;
        }

        $state = ['last_intent' => $reply->intent, 'intent_streak' => $streak, 'strikes' => $strikes];

        $reason = match (true) {
            $reply->needsHuman => 'ai_requested',
            $reply->sentiment === 'angry' => 'angry',
            $streak >= self::MAX_SAME_INTENT => 'loop',
            $strikes >= self::MAX_STRIKES => 'strikes',
            default => '',
        };

        return ['escalate' => $reason !== '', 'reason' => $reason, 'state' => $state];
    }
}
