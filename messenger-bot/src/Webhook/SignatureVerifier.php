<?php

declare(strict_types=1);

namespace MessengerBot\Webhook;

/**
 * Baseline security: reject any POST that Meta did not sign.
 * Meta signs the raw body with your App Secret in the X-Hub-Signature-256 header.
 */
final class SignatureVerifier
{
    public function __construct(private readonly string $appSecret)
    {
    }

    public function isValid(string $rawBody, ?string $signatureHeader): bool
    {
        if ($signatureHeader === null || !str_starts_with($signatureHeader, 'sha256=')) {
            return false;
        }
        $expected = 'sha256=' . hash_hmac('sha256', $rawBody, $this->appSecret);

        return hash_equals($expected, $signatureHeader);
    }
}
