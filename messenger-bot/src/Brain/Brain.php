<?php

declare(strict_types=1);

namespace MessengerBot\Brain;

interface Brain
{
    /**
     * @param list<array{role: string, content: string}> $history earlier turns, oldest first
     * @param list<string> $imageUrls images attached to the current message
     * @throws BrainUnavailable when the AI can't answer (outage, rate limit, refusal)
     */
    public function think(array $history, string $userText, array $imageUrls = []): BrainReply;
}
