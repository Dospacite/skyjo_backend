export type PersistRoomInput = {
  roomCode: string;
  status: string;
  settingsJson: Record<string, unknown>;
};

export type PersistRoomPlayerInput = {
  roomCode: string;
  playerId: string;
  displayName: string;
  seatIndex: number;
};

export type PersistGameStartedInput = {
  gameId: string;
  roomCode: string;
  startedAt: Date;
  rulesVariant: string;
};

export type PersistGameEndedInput = {
  gameId: string;
  endedAt: Date;
  winnerSeatIndex: number;
};

export type PersistRoundStartedInput = {
  roundId: string;
  gameId: string;
  roundNumber: number;
  startedAt: Date;
};

export type PersistRoundEndedInput = {
  roundId: string;
  endedAt: Date;
};

export type PersistRoundScoreInput = {
  roundId: string;
  seatIndex: number;
  score: number;
  doubled: boolean;
};

export interface StorageAdapter {
  migrate(): Promise<void>;
  close(): Promise<void>;
  upsertRoom(input: PersistRoomInput): Promise<void>;
  upsertRoomPlayer(input: PersistRoomPlayerInput): Promise<void>;
  markPlayerLeft(roomCode: string, playerId: string, leftAt: Date): Promise<void>;
  insertGameStarted(input: PersistGameStartedInput): Promise<void>;
  updateGameEnded(input: PersistGameEndedInput): Promise<void>;
  insertRoundStarted(input: PersistRoundStartedInput): Promise<void>;
  updateRoundEnded(input: PersistRoundEndedInput): Promise<void>;
  upsertRoundScore(input: PersistRoundScoreInput): Promise<void>;
  insertEvent(roomCode: string, eventType: string, payloadJson: Record<string, unknown>): Promise<void>;
  getGameSummariesByRoom(roomCode: string): Promise<Array<Record<string, unknown>>>;
}
