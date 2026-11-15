<?php

declare(strict_types=1);

namespace MessengerBot\Tests;

use MessengerBot\Brain\Brain;
use MessengerBot\Brain\BrainReply;
use MessengerBot\Brain\BrainUnavailable;
use MessengerBot\Messenger\Messenger;

final class FakeBrain implements Brain
{
    /** @var list<BrainReply|BrainUnavailable> */
    public array $queue = [];
    /** @var list<array{history: array, text: string, images: array}> */
    public array $calls = [];

    public function think(array $history, string $userText, array $imageUrls = []): BrainReply
    {
        $this->calls[] = ['history' => $history, 'text' => $userText, 'images' => $imageUrls];
        $next = array_shift($this->queue) ?? new BrainReply('ok', 'misc', 'high', 'neutral', false);
        if ($next instanceof BrainUnavailable) {
            throw $next;
        }

        return $next;
    }
}

final class FakeMessenger implements Messenger
{
    /** @var list<array{psid: string, text: string, quick_replies: array}> */
    public array $sent = [];
    /** @var list<string> */
    public array $actions = [];
    /** @var list<string> */
    public array $handoffs = [];

    public function sendText(string $psid, string $text, array $quickReplies = []): void
    {
        $this->sent[] = ['psid' => $psid, 'text' => $text, 'quick_replies' => $quickReplies];
    }

    public function senderAction(string $psid, string $action): void
    {
        $this->actions[] = $action;
    }

    public function passThreadControl(string $psid, string $targetAppId, string $metadata = ''): void
    {
        $this->handoffs[] = $metadata;
    }
}
