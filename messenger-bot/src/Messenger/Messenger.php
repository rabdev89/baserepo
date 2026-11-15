<?php

declare(strict_types=1);

namespace MessengerBot\Messenger;

interface Messenger
{
    /** @param list<array{content_type: string, title: string, payload: string}> $quickReplies */
    public function sendText(string $psid, string $text, array $quickReplies = []): void;

    /** 'typing_on' | 'typing_off' | 'mark_seen' */
    public function senderAction(string $psid, string $action): void;

    /** Hand the conversation to another app (e.g. the Page Inbox) so a person can reply. */
    public function passThreadControl(string $psid, string $targetAppId, string $metadata = ''): void;
}
