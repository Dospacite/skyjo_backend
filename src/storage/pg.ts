import { Pool, type PoolClient } from 'pg';
import { join } from 'node:path';
import { loadMigrationFiles } from './sql';
import type {
  PersistGameEndedInput,
  PersistGameStartedInput,
  PersistRoundEndedInput,
  PersistRoundScoreInput,
  PersistRoundStartedInput,
  PersistRoomInput,
  PersistRoomPlayerInput,
  StorageAdapter,
} from './types';

async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export class PgStorage implements StorageAdapter {
  constructor(private readonly pool: Pool, private readonly migrationsDir = join(process.cwd(), 'migrations')) {}

  async migrate(): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        );
        const rows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
        const applied = new Set(rows.rows.map((r: { version: string }) => r.version));
        for (const migration of loadMigrationFiles(this.migrationsDir)) {
          if (applied.has(migration.version)) {
            continue;
          }
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [migration.version]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertRoom(input: PersistRoomInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO rooms(room_code, status, settings_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_code)
       DO UPDATE SET status = EXCLUDED.status, settings_json = EXCLUDED.settings_json`,
      [input.roomCode, input.status, input.settingsJson],
    );
  }

  async upsertRoomPlayer(input: PersistRoomPlayerInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO room_players(room_code, player_id, display_name, seat_index)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_code, player_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, seat_index = EXCLUDED.seat_index, left_at = NULL`,
      [input.roomCode, input.playerId, input.displayName, input.seatIndex],
    );
  }

  async markPlayerLeft(roomCode: string, playerId: string, leftAt: Date): Promise<void> {
    await this.pool.query(
      'UPDATE room_players SET left_at = $3 WHERE room_code = $1 AND player_id = $2',
      [roomCode, playerId, leftAt],
    );
  }

  async insertGameStarted(input: PersistGameStartedInput): Promise<void> {
    await this.pool.query(
      'INSERT INTO games(game_id, room_code, started_at, rules_variant) VALUES ($1, $2, $3, $4)',
      [input.gameId, input.roomCode, input.startedAt, input.rulesVariant],
    );
  }

  async updateGameEnded(input: PersistGameEndedInput): Promise<void> {
    await this.pool.query('UPDATE games SET ended_at = $2, winner_seat_index = $3 WHERE game_id = $1', [
      input.gameId,
      input.endedAt,
      input.winnerSeatIndex,
    ]);
  }

  async insertRoundStarted(input: PersistRoundStartedInput): Promise<void> {
    await this.pool.query(
      'INSERT INTO rounds(round_id, game_id, round_number, started_at) VALUES ($1, $2, $3, $4)',
      [input.roundId, input.gameId, input.roundNumber, input.startedAt],
    );
  }

  async updateRoundEnded(input: PersistRoundEndedInput): Promise<void> {
    await this.pool.query('UPDATE rounds SET ended_at = $2 WHERE round_id = $1', [input.roundId, input.endedAt]);
  }

  async upsertRoundScore(input: PersistRoundScoreInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO round_scores(round_id, seat_index, score, doubled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (round_id, seat_index)
       DO UPDATE SET score = EXCLUDED.score, doubled = EXCLUDED.doubled`,
      [input.roundId, input.seatIndex, input.score, input.doubled],
    );
  }

  async insertEvent(roomCode: string, eventType: string, payloadJson: Record<string, unknown>): Promise<void> {
    await this.pool.query('INSERT INTO events(room_code, event_type, payload_json) VALUES ($1, $2, $3)', [
      roomCode,
      eventType,
      payloadJson,
    ]);
  }

  async getGameSummariesByRoom(roomCode: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT game_id, room_code, started_at, ended_at, winner_seat_index, rules_variant
       FROM games WHERE room_code = $1 ORDER BY started_at DESC`,
      [roomCode],
    );
    return result.rows;
  }
}
