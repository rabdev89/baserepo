<?php

declare(strict_types=1);

namespace MessengerBot\Brain;

use Anthropic\Client;
use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\Core\Exceptions\RateLimitException;

/**
 * Claude-powered understanding. Fixes:
 *  #2 rigid keyword menus     -> real language understanding, any language
 *  #5 confident wrong answers -> answers only from the knowledge base, reports its confidence
 *  #1/#4 frustration          -> reports sentiment + needs_human so the bot can escalate
 */
final class ClaudeBrain implements Brain
{
    private const SCHEMA = [
        'type' => 'object',
        'properties' => [
            'reply' => ['type' => 'string', 'description' => 'Message to send the customer. Plain text, no markdown.'],
            'intent' => ['type' => 'string', 'description' => 'Short snake_case label for what the customer wants, e.g. order_status, refund, opening_hours, greeting.'],
            'confidence' => ['type' => 'string', 'enum' => ['high', 'medium', 'low'], 'description' => 'How well the knowledge base supports the reply.'],
            'sentiment' => ['type' => 'string', 'enum' => ['positive', 'neutral', 'frustrated', 'angry']],
            'needs_human' => ['type' => 'boolean', 'description' => 'True if a person on the team should take over.'],
            'quick_replies' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Up to 3 short (max 20 characters) suggested next replies for the customer. May be empty.'],
        ],
        'required' => ['reply', 'intent', 'confidence', 'sentiment', 'needs_human', 'quick_replies'],
        'additionalProperties' => false,
    ];

    public function __construct(
        private readonly Client $client,
        private readonly string $model,
        private readonly string $businessName,
        private readonly string $knowledge,
    ) {
    }

    public function think(array $history, string $userText, array $imageUrls = []): BrainReply
    {
        $current = [];
        foreach ($imageUrls as $url) {
            $current[] = ['type' => 'image', 'source' => ['type' => 'url', 'url' => $url]];
        }
        $current[] = ['type' => 'text', 'text' => $userText !== '' ? $userText : '(The customer sent this image without text.)'];

        $messages = $this->toApiMessages($history);
        $messages[] = ['role' => 'user', 'content' => $current];
        $messages = $this->mergeConsecutive($messages);

        try {
            $response = $this->client->beta->messages->create(
                model: $this->model,
                maxTokens: 4000,
                system: [[
                    'type' => 'text',
                    'text' => $this->systemPrompt(),
                    'cacheControl' => ['type' => 'ephemeral'],
                ]],
                messages: $messages,
                outputConfig: [
                    'effort' => 'low', // chat: fast + cheap; raise if answers need more reasoning
                    'format' => ['type' => 'json_schema', 'schema' => self::SCHEMA],
                ],
                // If a safety classifier declines, the API retries on a fallback model itself.
                fallbacks: 'default',
                betas: ['server-side-fallback-2026-07-01'],
            );
        } catch (RateLimitException | APIConnectionException $e) {
            throw new BrainUnavailable('Claude temporarily unavailable: ' . $e->getMessage(), 0, $e);
        } catch (APIStatusException $e) {
            throw new BrainUnavailable('Claude API error: ' . $e->getMessage(), 0, $e);
        }

        if ($response->stopReason === 'refusal') {
            throw new BrainUnavailable('Claude declined this request.');
        }

        foreach ($response->content as $block) {
            if ($block->type === 'text') {
                $data = json_decode($block->text, true);
                if (is_array($data) && trim((string) ($data['reply'] ?? '')) !== '') {
                    return BrainReply::fromArray($data);
                }
            }
        }

        throw new BrainUnavailable('Claude returned no usable reply (stop reason: ' . (string) $response->stopReason . ').');
    }

    private function systemPrompt(): string
    {
        return <<<PROMPT
        You are the Messenger assistant for {$this->businessName}. Customers reach you through
        Facebook Messenger on their phones.

        How to answer:
        - Use only the knowledge base below for facts about the business (prices, policies, hours,
          stock, delivery). If it does not cover the question, say you are not sure, do not guess,
          and offer to connect them with a person. Set confidence to "low" in that case.
        - Read the whole conversation. Never ask for something the customer already told you.
        - Reply in the same language the customer writes in.
        - Keep replies short and conversational: usually 1-3 sentences, never more than 600 characters.
          Messenger shows plain text only, so do not use markdown, headings, or bullet symbols.
        - If the customer sends a photo, describe what is relevant and help with it.
        - Suggest up to 3 quick replies when they would save the customer typing; otherwise none.

        Set needs_human to true when the customer asks for a person, is upset or repeating
        themselves, or wants something you cannot do from here (refunds, account changes,
        complaints, payment problems, anything legal or medical). When needs_human is true,
        keep the reply to a short, warm acknowledgement; the system adds the handoff message.

        Never invent order numbers, tracking links, discounts, or promises.

        <knowledge_base>
        {$this->knowledge}
        </knowledge_base>
        PROMPT;
    }

    /**
     * @param list<array{role: string, content: string}> $history
     * @return list<array{role: string, content: mixed}>
     */
    private function toApiMessages(array $history): array
    {
        $out = [];
        foreach ($history as $h) {
            $role = $h['role'] === 'assistant' ? 'assistant' : 'user';
            $out[] = ['role' => $role, 'content' => [['type' => 'text', 'text' => $h['content']]]];
        }
        // The API requires the conversation to start with a user turn.
        while ($out !== [] && $out[0]['role'] !== 'user') {
            array_shift($out);
        }

        return $out;
    }

    /**
     * Messenger users often send several messages in a row; the API needs alternating roles.
     *
     * @param list<array{role: string, content: list<array<string, mixed>>}> $messages
     * @return list<array{role: string, content: list<array<string, mixed>>}>
     */
    private function mergeConsecutive(array $messages): array
    {
        $merged = [];
        foreach ($messages as $m) {
            $last = array_key_last($merged);
            if ($last !== null && $merged[$last]['role'] === $m['role']) {
                $merged[$last]['content'] = array_merge($merged[$last]['content'], $m['content']);
            } else {
                $merged[] = $m;
            }
        }

        return $merged;
    }
}
