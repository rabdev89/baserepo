<?php

declare(strict_types=1);

namespace MessengerBot\Webhook;

/**
 * One normalized thing a user did. Every Messenger input shape
 * (text, quick reply, postback, sticker, image, voice note, handover)
 * is turned into this so the bot never crashes on an unexpected payload.
 */
final class InboundEvent
{
    public const TEXT = 'text';
    public const IMAGE = 'image';
    public const UNSUPPORTED_MEDIA = 'unsupported_media';
    public const GET_STARTED = 'get_started';
    public const HANDBACK = 'handback';   // a human/inbox app passed the thread back to the bot

    /**
     * @param list<string> $imageUrls
     */
    public function __construct(
        public readonly string $kind,
        public readonly string $psid,
        public readonly string $eventId,
        public readonly int $timestampMs,
        public readonly string $text = '',
        public readonly array $imageUrls = [],
        public readonly string $mediaType = '',
    ) {
    }
}
