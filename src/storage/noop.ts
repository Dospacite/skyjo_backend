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

export class NoopStorage implements StorageAdapter {
  public readonly events: Array<{ roomCode: string; eventType: string; payloadJson: Record<string, unknown> }> = [];
  public readonly games = new Map<string, Record<string, unknown>>();

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}
  async upsertRoom(_input: PersistRoomInput): Promise<void> {}
  async upsertRoomPlayer(_input: PersistRoomPlayerInput): Promise<void> {}
  async markPlayerLeft(_roomCode: string, _playerId: string, _leftAt: Date): Promise<void> {}
  async insertGameStarted(input: PersistGameStartedInput): Promise<void> {
    this.games.set(input.gameId, { ...input });
  }
  async updateGameEnded(input: PersistGameEndedInput): Promise<void> {
    const existing = this.games.get(input.gameId) ?? { gameId: input.gameId };
    this.games.set(input.gameId, { ...existing, ...input });
  }
  async insertRoundStarted(_input: PersistRoundStartedInput): Promise<void> {}
  async updateRoundEnded(_input: PersistRoundEndedInput): Promise<void> {}
  async upsertRoundScore(_input: PersistRoundScoreInput): Promise<void> {}
  async insertEvent(roomCode: string, eventType: string, payloadJson: Record<string, unknown>): Promise<void> {
    this.events.push({ roomCode, eventType, payloadJson });
  }
  async getGameSummariesByRoom(roomCode: string): Promise<Array<Record<string, unknown>>> {
    return [...this.games.values()].filter((g) => g.roomCode === roomCode);
  }
}
