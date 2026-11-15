<?php

declare(strict_types=1);

/*
 * Messenger webhook endpoint. Point your Meta app's webhook URL here.
 *   GET  -> subscription verification
 *   POST -> incoming events
 */

use Anthropic\Client;
use MessengerBot\Bot;
use MessengerBot\Brain\ClaudeBrain;
use MessengerBot\Config;
use MessengerBot\Messenger\GraphMessenger;
use MessengerBot\Store\ConversationStore;
use MessengerBot\Webhook\EventParser;
use MessengerBot\Webhook\SignatureVerifier;

require __DIR__ . '/../vendor/autoload.php';

$baseDir = dirname(__DIR__);
$config = Config::fromEnv($baseDir);

// --- Webhook verification -------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $mode = $_GET['hub_mode'] ?? '';
    $token = $_GET['hub_verify_token'] ?? '';
    if ($mode === 'subscribe' && hash_equals($config->verifyToken, (string) $token)) {
        header('Content-Type: text/plain');
        echo (string) ($_GET['hub_challenge'] ?? '');
    } else {
        http_response_code(403);
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit;
}

// --- Security: only accept events signed by Meta --------------------------
$raw = (string) file_get_contents('php://input');
$verifier = new SignatureVerifier($config->appSecret);
if (!$verifier->isValid($raw, $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? null)) {
    http_response_code(401);
    exit;
}

$payload = json_decode($raw, true);
$events = is_array($payload) ? (new EventParser())->parse($payload) : [];

// --- #8 Acknowledge immediately --------------------------------------------
// Meta expects a 200 quickly or it retries (causing duplicates) and can disable the webhook.
// Reply now, then do the slow AI work after the connection is closed.
http_response_code(200);
header('Content-Type: text/plain');
echo 'EVENT_RECEIVED';
ignore_user_abort(true);
set_time_limit(120);
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} else {
    @ob_end_flush();
    flush();
}

if ($events === []) {
    exit;
}

$knowledge = is_readable($config->knowledgePath) ? (string) file_get_contents($config->knowledgePath) : '';

$bot = new Bot(
    store: new ConversationStore($config->dbPath),
    brain: new ClaudeBrain(new Client(), $config->claudeModel, $config->businessName, $knowledge),
    messenger: new GraphMessenger($config->pageAccessToken, $config->graphApiVersion),
    config: $config,
);

foreach ($events as $event) {
    try {
        $bot->handle($event);
    } catch (\Throwable $e) {
        error_log('[messenger-bot] unhandled: ' . $e::class . ': ' . $e->getMessage());
    }
}
