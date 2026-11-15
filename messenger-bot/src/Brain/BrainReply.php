<?php

declare(strict_types=1);

namespace MessengerBot\Brain;

/**
 * What the AI decided for one turn. Structured so the bot can act on
 * confidence/sentiment instead of blindly sending text.
 */
final class BrainReply
{
    /**
     * @param list<string> $quickReplies
     */
    public function __construct(
        public readonly string $reply,
        public readonly string $intent,
        public readonly string $confidence,   // high | medium | low
        public readonly string $sentiment,    // positive | neutral | frustrated | angry
        public readonly bool $needsHuman,
        public readonly array $quickReplies = [],
    ) {
    }

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            reply: trim((string) ($data['reply'] ?? '')),
            intent: strtolower(trim((string) ($data['intent'] ?? 'unknown'))),
            confidence: (string) ($data['confidence'] ?? 'low'),
            sentiment: (string) ($data['sentiment'] ?? 'neutral'),
            needsHuman: (bool) ($data['needs_human'] ?? false),
            quickReplies: array_values(array_filter(array_map('strval', (array) ($data['quick_replies'] ?? [])))),
        );
    }
}
