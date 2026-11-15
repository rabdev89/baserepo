<?php

declare(strict_types=1);

namespace MessengerBot\Webhook;

/**
 * Fixes problem #10: bots that break or go silent on anything except plain text.
 * Maps every webhook shape to an InboundEvent, and drops noise
 * (echoes, delivery/read receipts, standby events while a human owns the thread).
 */
final class EventParser
{
    /** Facebook's built-in "thumbs up" sticker IDs. */
    private const LIKE_STICKERS = ['369239263222822', '369239343222814', '369239383222810'];

    /**
     * @param array<string, mixed> $payload decoded webhook body
     * @return list<InboundEvent>
     */
    public function parse(array $payload): array
    {
        if (($payload['object'] ?? null) !== 'page') {
            return [];
        }

        $events = [];
        foreach ($payload['entry'] ?? [] as $entry) {
            // 'standby' = messages delivered while another app (the human inbox) owns the thread. Ignore.
            foreach ($entry['messaging'] ?? [] as $m) {
                $event = $this->parseOne($m);
                if ($event !== null) {
                    $events[] = $event;
                }
            }
        }

        return $events;
    }

    /** @param array<string, mixed> $m */
    private function parseOne(array $m): ?InboundEvent
    {
        $psid = (string) ($m['sender']['id'] ?? '');
        $ts = (int) ($m['timestamp'] ?? (int) (microtime(true) * 1000));
        if ($psid === '') {
            return null;
        }

        // Thread handed back to us by the Page Inbox / another app.
        if (isset($m['pass_thread_control'])) {
            return new InboundEvent(InboundEvent::HANDBACK, $psid, "handback:{$psid}:{$ts}", $ts);
        }

        if (isset($m['postback'])) {
            $payload = (string) ($m['postback']['payload'] ?? '');
            $title = (string) ($m['postback']['title'] ?? $payload);
            $id = (string) ($m['postback']['mid'] ?? "postback:{$psid}:{$ts}");
            $kind = $payload === 'GET_STARTED' ? InboundEvent::GET_STARTED : InboundEvent::TEXT;

            return new InboundEvent($kind, $psid, $id, $ts, $title);
        }

        $msg = $m['message'] ?? null;
        if (!is_array($msg) || !empty($msg['is_echo'])) {
            return null; // deliveries, reads, reactions, and our own echoes
        }
        $mid = (string) ($msg['mid'] ?? "msg:{$psid}:{$ts}");

        if (isset($msg['quick_reply']['payload'])) {
            // Use the visible text so the model sees what the user "said".
            return new InboundEvent(InboundEvent::TEXT, $psid, $mid, $ts, (string) ($msg['text'] ?? $msg['quick_reply']['payload']));
        }

        if (isset($msg['sticker_id']) && in_array((string) $msg['sticker_id'], self::LIKE_STICKERS, true)) {
            return new InboundEvent(InboundEvent::TEXT, $psid, $mid, $ts, '👍');
        }

        $text = trim((string) ($msg['text'] ?? ''));
        $images = [];
        $otherMedia = '';
        foreach ($msg['attachments'] ?? [] as $att) {
            $type = (string) ($att['type'] ?? '');
            $url = (string) ($att['payload']['url'] ?? '');
            if ($type === 'image' && $url !== '' && !isset($att['payload']['sticker_id'])) {
                $images[] = $url;
            } elseif ($type === 'image' && isset($att['payload']['sticker_id'])) {
                $text = $text !== '' ? $text : '👍';
            } elseif ($type !== 'fallback' && $type !== '') {
                $otherMedia = $type; // audio, video, file, location...
            }
        }

        if ($images !== []) {
            return new InboundEvent(InboundEvent::IMAGE, $psid, $mid, $ts, $text, $images);
        }
        if ($text !== '') {
            return new InboundEvent(InboundEvent::TEXT, $psid, $mid, $ts, $text);
        }
        if ($otherMedia !== '') {
            return new InboundEvent(InboundEvent::UNSUPPORTED_MEDIA, $psid, $mid, $ts, '', [], $otherMedia);
        }

        return null;
    }
}
