<?php

declare(strict_types=1);

namespace MessengerBot\Store;

use PDO;

/**
 * SQLite persistence. Fixes:
 *  #3 bot forgets context  -> per-user message history
 *  #7 duplicate webhooks    -> processed event IDs (idempotency)
 *  #6 24h window             -> last time the user messaged us
 *  #1/#4 handoff + loops     -> handed_off flag, intent streaks, strike counter
 */
final class ConversationStore
{
    private PDO $db;

    public function __construct(string $dsnPath)
    {
        if ($dsnPath !== ':memory:' && !is_dir(dirname($dsnPath))) {
            mkdir(dirname($dsnPath), 0775, true);
        }
        $this->db = new PDO('sqlite:' . $dsnPath);
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec('PRAGMA journal_mode=WAL');
        $this->migrate();
    }

    private function migrate(): void
    {
        $this->db->exec(<<<SQL
            CREATE TABLE IF NOT EXISTS processed_events (
                event_id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                psid TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_psid ON messages(psid, id);
            CREATE TABLE IF NOT EXISTS users (
                psid TEXT PRIMARY KEY,
                last_user_at INTEGER NOT NULL DEFAULT 0,
                handed_off INTEGER NOT NULL DEFAULT 0,
                last_intent TEXT NOT NULL DEFAULT '',
                intent_streak INTEGER NOT NULL DEFAULT 0,
                strikes INTEGER NOT NULL DEFAULT 0
            );
        SQL);
    }

    /** Returns true only the first time an event ID is seen. */
    public function markProcessed(string $eventId): bool
    {
        $stmt = $this->db->prepare('INSERT OR IGNORE INTO processed_events (event_id, created_at) VALUES (?, ?)');
        $stmt->execute([$eventId, time()]);

        return $stmt->rowCount() === 1;
    }

    public function addMessage(string $psid, string $role, string $content): void
    {
        $this->db->prepare('INSERT INTO messages (psid, role, content, created_at) VALUES (?, ?, ?, ?)')
            ->execute([$psid, $role, $content, time()]);
    }

    /** @return list<array{role: string, content: string}> oldest first */
    public function recentMessages(string $psid, int $limit = 20): array
    {
        $stmt = $this->db->prepare('SELECT role, content FROM messages WHERE psid = ? ORDER BY id DESC LIMIT ?');
        $stmt->bindValue(1, $psid);
        $stmt->bindValue(2, $limit, PDO::PARAM_INT);
        $stmt->execute();

        return array_reverse($stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** @return array{psid: string, last_user_at: int, handed_off: int, last_intent: string, intent_streak: int, strikes: int} */
    public function user(string $psid): array
    {
        $this->db->prepare('INSERT OR IGNORE INTO users (psid) VALUES (?)')->execute([$psid]);
        $stmt = $this->db->prepare('SELECT * FROM users WHERE psid = ?');
        $stmt->execute([$psid]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return [
            'psid' => (string) $row['psid'],
            'last_user_at' => (int) $row['last_user_at'],
            'handed_off' => (int) $row['handed_off'],
            'last_intent' => (string) $row['last_intent'],
            'intent_streak' => (int) $row['intent_streak'],
            'strikes' => (int) $row['strikes'],
        ];
    }

    /** @param array<string, int|string> $fields */
    public function updateUser(string $psid, array $fields): void
    {
        $this->user($psid);
        $allowed = ['last_user_at', 'handed_off', 'last_intent', 'intent_streak', 'strikes'];
        $sets = [];
        $values = [];
        foreach ($fields as $k => $v) {
            if (in_array($k, $allowed, true)) {
                $sets[] = "{$k} = ?";
                $values[] = $v;
            }
        }
        if ($sets === []) {
            return;
        }
        $values[] = $psid;
        $this->db->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE psid = ?')->execute($values);
    }

    /** Housekeeping: keep the dedupe table small. Call from cron. */
    public function pruneProcessed(int $olderThanSeconds = 172800): void
    {
        $this->db->prepare('DELETE FROM processed_events WHERE created_at < ?')->execute([time() - $olderThanSeconds]);
    }
}
