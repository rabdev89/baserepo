<?php

declare(strict_types=1);

namespace MessengerBot\Tests;

use MessengerBot\Messenger\MessageFormatter;
use MessengerBot\Policy\EscalationPolicy;
use MessengerBot\Policy\MessagingWindow;
use MessengerBot\Webhook\EventParser;
use MessengerBot\Webhook\InboundEvent;
use MessengerBot\Webhook\SignatureVerifier;
use PHPUnit\Framework\TestCase;

final class ComponentsTest extends TestCase
{
    public function testSignatureVerification(): void
    {
        $v = new SignatureVerifier('s3cret');
        $body = '{"object":"page"}';

        self::assertTrue($v->isValid($body, 'sha256=' . hash_hmac('sha256', $body, 's3cret')));
        self::assertFalse($v->isValid($body, 'sha256=deadbeef'));
        self::assertFalse($v->isValid($body, null));
    }

    /** @param array<string, mixed> $messaging */
    private function parseOne(array $messaging): ?InboundEvent
    {
        $events = (new EventParser())->parse([
            'object' => 'page',
            'entry' => [['messaging' => [array_merge(['sender' => ['id' => 'u1'], 'timestamp' => 1000], $messaging)]]],
        ]);

        return $events[0] ?? null;
    }

    public function testParsesEveryInputShape(): void
    {
        self::assertSame('hi', $this->parseOne(['message' => ['mid' => 'a', 'text' => 'hi']])->text);
        self::assertNull($this->parseOne(['message' => ['mid' => 'b', 'text' => 'x', 'is_echo' => true]]));
        self::assertNull($this->parseOne(['delivery' => ['mids' => ['a']]]));
        self::assertSame('Yes', $this->parseOne(['message' => ['mid' => 'c', 'text' => 'Yes', 'quick_reply' => ['payload' => 'QR:Yes']]])->text);
        self::assertSame(InboundEvent::GET_STARTED, $this->parseOne(['postback' => ['payload' => 'GET_STARTED', 'title' => 'Get Started']])->kind);
        self::assertSame('👍', $this->parseOne(['message' => ['mid' => 'd', 'sticker_id' => 369239263222822, 'attachments' => [['type' => 'image', 'payload' => ['url' => 'u', 'sticker_id' => 369239263222822]]]]])->text);

        $img = $this->parseOne(['message' => ['mid' => 'e', 'attachments' => [['type' => 'image', 'payload' => ['url' => 'https://cdn/x.jpg']]]]]);
        self::assertSame(InboundEvent::IMAGE, $img->kind);

        $audio = $this->parseOne(['message' => ['mid' => 'f', 'attachments' => [['type' => 'audio', 'payload' => ['url' => 'https://cdn/x.mp4']]]]]);
        self::assertSame('audio', $audio->mediaType);

        self::assertSame(InboundEvent::HANDBACK, $this->parseOne(['pass_thread_control' => ['new_owner_app_id' => '1']])->kind);
    }

    public function testMessagingWindow(): void
    {
        $w = new MessagingWindow();
        self::assertTrue($w->isOpen(1000, 1000 + 3600));
        self::assertFalse($w->isOpen(1000, 1000 + 25 * 3600));
        self::assertFalse($w->isOpen(0, 1000));
    }

    public function testHumanRequestDetectionIsMultilingual(): void
    {
        $p = new EscalationPolicy();
        self::assertTrue($p->userAskedForHuman('can I speak to someone'));
        self::assertTrue($p->userAskedForHuman('Talk to a person'));
        self::assertTrue($p->userAskedForHuman('quiero hablar con un agente'));
        self::assertTrue($p->userAskedForHuman('gusto ko ng totoong tao'));
        self::assertFalse($p->userAskedForHuman('what time do you open'));
    }

    public function testFormatterLimitsAndMarkdown(): void
    {
        $f = new MessageFormatter();
        self::assertSame(['Price: 5'], $f->splitText('**Price:** 5'));

        $qrs = $f->quickReplies(array_merge(['A very long quick reply title here'], array_map('strval', range(1, 20))));
        self::assertCount(13, $qrs);
        self::assertLessThanOrEqual(20, mb_strlen($qrs[0]['title']));
    }
}
