<?php

declare(strict_types=1);

namespace MessengerBot\Messenger;

/**
 * Fixes problem #9: Send API errors from oversized or malformed messages.
 * Messenger limits: text 2000 chars, max 13 quick replies, quick reply title 20 chars,
 * payload 1000 chars. Also strips markdown, which Messenger shows as raw symbols.
 */
final class MessageFormatter
{
    public const MAX_TEXT = 2000;
    public const MAX_QUICK_REPLIES = 13;
    public const MAX_QR_TITLE = 20;

    /** @return list<string> */
    public function splitText(string $text): array
    {
        $text = $this->stripMarkdown(trim($text));
        if ($text === '') {
            return [];
        }

        $chunks = [];
        while (mb_strlen($text) > self::MAX_TEXT) {
            $slice = mb_substr($text, 0, self::MAX_TEXT);
            // Prefer to break at a paragraph, then sentence, then word boundary.
            $cut = max(mb_strrpos($slice, "\n\n") ?: 0, mb_strrpos($slice, '. ') ?: 0);
            if ($cut < self::MAX_TEXT / 2) {
                $cut = mb_strrpos($slice, ' ') ?: self::MAX_TEXT;
            } else {
                $cut += 1;
            }
            $chunks[] = trim(mb_substr($text, 0, $cut));
            $text = trim(mb_substr($text, $cut));
        }
        if ($text !== '') {
            $chunks[] = $text;
        }

        return $chunks;
    }

    /**
     * @param list<string> $titles
     * @return list<array{content_type: string, title: string, payload: string}>
     */
    public function quickReplies(array $titles): array
    {
        $out = [];
        $seen = [];
        foreach ($titles as $title) {
            $title = trim($this->stripMarkdown($title));
            if ($title === '') {
                continue;
            }
            if (mb_strlen($title) > self::MAX_QR_TITLE) {
                $title = rtrim(mb_substr($title, 0, self::MAX_QR_TITLE - 1)) . '…';
            }
            $key = mb_strtolower($title);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = [
                'content_type' => 'text',
                'title' => $title,
                'payload' => 'QR:' . mb_substr($title, 0, 900),
            ];
            if (count($out) === self::MAX_QUICK_REPLIES) {
                break;
            }
        }

        return $out;
    }

    private function stripMarkdown(string $text): string
    {
        $text = preg_replace('/\*\*(.+?)\*\*|__(.+?)__/u', '$1$2', $text) ?? $text;
        $text = preg_replace('/^#{1,6}\s+/mu', '', $text) ?? $text;
        $text = preg_replace('/\[([^\]]+)\]\((https?:[^)]+)\)/u', '$1: $2', $text) ?? $text;
        $text = preg_replace('/^\s*[-*]\s+/mu', '• ', $text) ?? $text;

        return $text;
    }
}
