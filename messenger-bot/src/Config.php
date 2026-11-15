<?php

declare(strict_types=1);

namespace MessengerBot;

/**
 * All settings come from environment variables (see .env.example).
 */
final class Config
{
    public function __construct(
        public readonly string $pageAccessToken,
        public readonly string $appSecret,
        public readonly string $verifyToken,
        public readonly string $graphApiVersion = 'v24.0',
        public readonly string $humanInboxAppId = '263902037430900',
        public readonly string $claudeModel = 'claude-opus-5-5',
        public readonly string $businessName = 'our business',
        public readonly string $humanReplyEta = 'as soon as possible',
        public readonly string $dbPath = 'storage/bot.sqlite',
        public readonly string $knowledgePath = 'knowledge/faq.md',
    ) {
    }

    public static function fromEnv(string $baseDir): self
    {
        self::loadDotEnv($baseDir . '/.env');

        $get = static fn (string $key, ?string $default = null): string =>
            (string) (getenv($key) !== false ? getenv($key) : ($default ?? throw new \RuntimeException("Missing env var {$key}")));

        $path = static fn (string $p): string => str_starts_with($p, '/') ? $p : $baseDir . '/' . $p;

        return new self(
            pageAccessToken: $get('PAGE_ACCESS_TOKEN'),
            appSecret: $get('APP_SECRET'),
            verifyToken: $get('VERIFY_TOKEN'),
            graphApiVersion: $get('GRAPH_API_VERSION', 'v24.0'),
            humanInboxAppId: $get('HUMAN_INBOX_APP_ID', '263902037430900'),
            claudeModel: $get('CLAUDE_MODEL', 'claude-opus-5-5'),
            businessName: $get('BUSINESS_NAME', 'our business'),
            humanReplyEta: $get('HUMAN_REPLY_ETA', 'as soon as possible'),
            dbPath: $path($get('DB_PATH', 'storage/bot.sqlite')),
            knowledgePath: $path($get('KNOWLEDGE_PATH', 'knowledge/faq.md')),
        );
    }

    /** Minimal .env loader so the bot runs without extra packages. Real env vars win. */
    private static function loadDotEnv(string $file): void
    {
        if (!is_readable($file)) {
            return;
        }
        foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = array_map('trim', explode('=', $line, 2));
            if (getenv($key) === false) {
                putenv("{$key}=" . trim($value, "\"'"));
            }
        }
    }
}
