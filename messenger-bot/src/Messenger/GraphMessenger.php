<?php

declare(strict_types=1);

namespace MessengerBot\Messenger;

/**
 * Thin Graph API client for the Messenger Send API and Handover Protocol.
 * Retries transient failures (5xx, rate limits) with backoff.
 */
final class GraphMessenger implements Messenger
{
    public function __construct(
        private readonly string $pageAccessToken,
        private readonly string $graphApiVersion = 'v24.0',
    ) {
    }

    public function sendText(string $psid, string $text, array $quickReplies = []): void
    {
        $message = ['text' => $text];
        if ($quickReplies !== []) {
            $message['quick_replies'] = $quickReplies;
        }
        $this->post('me/messages', [
            'recipient' => ['id' => $psid],
            'messaging_type' => 'RESPONSE',
            'message' => $message,
        ]);
    }

    public function senderAction(string $psid, string $action): void
    {
        try {
            $this->post('me/messages', ['recipient' => ['id' => $psid], 'sender_action' => $action], retries: 0);
        } catch (\RuntimeException) {
            // Typing indicators are cosmetic; never fail a conversation over one.
        }
    }

    public function passThreadControl(string $psid, string $targetAppId, string $metadata = ''): void
    {
        $this->post('me/pass_thread_control', [
            'recipient' => ['id' => $psid],
            'target_app_id' => $targetAppId,
            'metadata' => mb_substr($metadata, 0, 1000),
        ]);
    }

    /** @param array<string, mixed> $body */
    private function post(string $path, array $body, int $retries = 2): void
    {
        $url = sprintf('https://graph.facebook.com/%s/%s', $this->graphApiVersion, $path);

        for ($attempt = 0; ; $attempt++) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $this->pageAccessToken],
                CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 10,
            ]);
            $response = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlError = curl_error($ch);
            curl_close($ch);

            if ($status >= 200 && $status < 300) {
                return;
            }

            $retryable = $status === 0 || $status === 429 || $status >= 500;
            if (!$retryable || $attempt >= $retries) {
                $detail = is_string($response) && $response !== '' ? $response : $curlError;
                throw new \RuntimeException("Graph API {$path} failed (HTTP {$status}): {$detail}");
            }
            usleep((int) (250_000 * (2 ** $attempt)));
        }
    }
}
