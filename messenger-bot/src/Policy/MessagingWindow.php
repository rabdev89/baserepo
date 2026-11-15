<?php

declare(strict_types=1);

namespace MessengerBot\Policy;

/**
 * Fixes problem #6: pages getting restricted for messaging outside Meta's 24-hour window.
 * Automated messages may only be sent within 24h of the user's last message.
 * (The HUMAN_AGENT tag extends this to 7 days, but only for messages typed by a person.)
 */
final class MessagingWindow
{
    public const STANDARD_SECONDS = 24 * 3600;

    public function isOpen(int $lastUserMessageAt, ?int $now = null): bool
    {
        $now ??= time();

        return $lastUserMessageAt > 0 && ($now - $lastUserMessageAt) < self::STANDARD_SECONDS;
    }
}
