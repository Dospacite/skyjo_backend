import { randomBytes, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import { applyAction, createGame, GameRuleError, setPlayerConnected, startNextRound, toPrivateAddon, toPublicSnapshot, type SkyjoGameState } from '../game';
import { AppError } from '../types/errors';
import type { ServerWsEnvelope } from '../types/ws';
import type { StorageAdapter } from '../storage/types';
import {
  AuthPayloadSchema,
  ClientEnvelopeSchema,
  ConfirmEndRoundPayloadSchema,
  DiscardColumnPayloadSchema,
  DiscardDrawnAndRevealPayloadSchema,
  DrawDeckPayloadSchema,
  RevealInitialPayloadSchema,
  RoomReadyPayloadSchema,
  RoomSettingsPayloadSchema,
  TargetPosPayloadSchema,
} from './schemas';
import { signPlayerToken, verifyPlayerToken, type PlayerTokenPayload } from './tokens';
import type { MetricsState } from './metrics';
import type pino from 'pino';

export type RoomStatus = 'LOBBY' | 'IN_ROUND' | 'ROUND_END' | 'GAME_END';

interface RoomSeat {
  seatIndex: number;
  playerId: string;
  displayName: string;
  ready: boolean;
  connected: boolean;
  joinedAt: number;
  leftAt: number | null;
  disconnectedAt: number | null;
  reconnectDeadline: number | null;
}

interface Room {
  roomCode: string;
  createdAt: number;
  updatedAt: number;
  status: RoomStatus;
  hostSeatIndex: number | null;
  maxPlayers: number;
  rulesVariant: 'canonical';
  initialRevealCount: number;
  maxScore: number;
  maxRounds: number;
  seats: Array<RoomSeat | null>;
  game: SkyjoGameState | null;
  actionQueue: Promise<void>;
  idempotencyCache: Map<string, { expiresAt: number; response: ServerWsEnvelope }>;
  persistedGameId: string | null;
  persistedGameEnded: boolean;
  persistedRoundStarts: Set<string>;
  persistedRoundEnds: Set<string>;
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  isAlive: boolean;
  authed: boolean;
  roomCode: string | null;
  playerId: string | null;
  seatIndex: number | null;
  requestCache: Map<string, { expiresAt: number; response: ServerWsEnvelope }>;
  wsWindowStartedAt: number;
  wsWindowCount: number;
}

export interface CreateRoomInput {
  displayName: string;
  maxPlayers: number;
  rulesVariant: 'canonical';
}

export interface JoinRoomInput {
  roomCode: string;
  displayName: string;
}

export interface RoomPublicState {
  roomCode: string;
  status: RoomStatus;
  createdAt: number;
  updatedAt: number;
  hostSeatIndex: number | null;
  maxPlayers: number;
  rulesVariant: 'canonical';
  initialRevealCount: number;
  maxScore: number;
  maxRounds: number;
  players: Array<{
    seatIndex: number;
    playerId: string;
    displayName: string;
    ready: boolean;
    connected: boolean;
  }>;
  game: ReturnType<typeof toPublicSnapshot> | null;
}

function nowMs(): number {
  return Date.now();
}

function seededRngFromString(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let t = h >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeRoomCode(code: string): string {
  return code.trim().replace(/\D/g, '').slice(0, 6);
}

function generateRoomCode(existing: Set<string>): string {
  const digits = '0123456789';
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const bytes = randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      code += digits[bytes[i]! % 10];
    }
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new AppError('ROOM_CODE_EXHAUSTED', 'Unable to allocate room code', 500);
}

function roomStatusFromGame(game: SkyjoGameState | null): RoomStatus {
  if (!game) {
    return 'LOBBY';
  }
  if (game.phase === 'ROUND_ENDED') {
    return 'ROUND_END';
  }
  if (game.phase === 'GAME_ENDED') {
    return 'GAME_END';
  }
  return 'IN_ROUND';
}

function toRoomPublicState(room: Room): RoomPublicState {
  return {
    roomCode: room.roomCode,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hostSeatIndex: room.hostSeatIndex,
    maxPlayers: room.maxPlayers,
    rulesVariant: room.rulesVariant,
    initialRevealCount: room.initialRevealCount,
    maxScore: room.maxScore,
    maxRounds: room.maxRounds,
    players: room.seats
      .filter((seat): seat is RoomSeat => Boolean(seat))
      .filter((seat) => seat.leftAt === null)
      .map((seat) => ({
        seatIndex: seat.seatIndex,
        playerId: seat.playerId,
        displayName: seat.displayName,
        ready: seat.ready,
        connected: seat.connected,
      })),
    game: room.game ? toPublicSnapshot(room.game) : null,
  };
}

function seatCacheKey(seatIndex: number, requestId: string): string {
  return `${seatIndex}:${requestId}`;
}

function createErrorEnvelope(requestId: string, code: string, message: string, details?: unknown): ServerWsEnvelope {
  return { type: 'response', requestId, ok: false, error: { code, message, details } };
}

function createOkEnvelope(requestId: string, payload: Record<string, unknown> = {}): ServerWsEnvelope {
  return { type: 'response', requestId, ok: true, payload };
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<string, ClientConnection>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: StorageAdapter,
    private readonly logger: pino.Logger,
    private readonly metrics: MetricsState,
  ) {}

  startBackgroundTasks(): void {
    const heartbeatMs = this.config.WS_HEARTBEAT_SECONDS * 1000;
    this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), heartbeatMs);
    const cleanupMs = Math.min(60_000, Math.max(10_000, Math.floor((this.config.ROOM_IDLE_TTL_MINUTES * 60_000) / 2)));
    this.cleanupTimer = setInterval(() => this.cleanupIdleRooms(), cleanupMs);
    this.heartbeatTimer.unref();
    this.cleanupTimer.unref();
  }

  stopBackgroundTasks(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.heartbeatTimer = null;
    this.cleanupTimer = null;
  }

  async shutdown(): Promise<void> {
    this.stopBackgroundTasks();
    for (const conn of this.connections.values()) {
      try {
        conn.ws.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.metrics.activeConnections = 0;
  }

  createUnauthedConnection(ws: WebSocket): ClientConnection {
    const conn: ClientConnection = {
      id: randomUUID(),
      ws,
      isAlive: true,
      authed: false,
      roomCode: null,
      playerId: null,
      seatIndex: null,
      requestCache: new Map(),
      wsWindowStartedAt: nowMs(),
      wsWindowCount: 0,
    };
    this.connections.set(conn.id, conn);
    this.metrics.activeConnections = this.connections.size;
    return conn;
  }

  onPong(conn: ClientConnection): void {
    conn.isAlive = true;
  }

  onSocketClose(conn: ClientConnection): void {
    this.connections.delete(conn.id);
    this.metrics.activeConnections = this.connections.size;

    if (!conn.authed || conn.roomCode === null || conn.seatIndex === null || conn.playerId === null) {
      return;
    }
    const room = this.rooms.get(conn.roomCode);
    if (!room) {
      return;
    }
    const seat = room.seats[conn.seatIndex];
    if (!seat || seat.playerId !== conn.playerId) {
      return;
    }
    const now = nowMs();
    seat.connected = false;
    seat.disconnectedAt = now;
    seat.reconnectDeadline = now + this.config.RECONNECT_GRACE_SECONDS * 1000;
    room.updatedAt = now;
    if (room.game) {
      room.game = setPlayerConnected(room.game, seat.seatIndex, false);
      room.status = roomStatusFromGame(room.game);
    }
    this.broadcastRoomEvent(room, 'room.playerLeft', { seatIndex: seat.seatIndex, disconnected: true });
    this.broadcastSnapshot(room);
  }

  async createRoom(input: CreateRoomInput): Promise<{ roomCode: string; playerToken: string }> {
    const roomCode = generateRoomCode(new Set(this.rooms.keys()));
    const createdAt = nowMs();
    const playerId = randomUUID();
    const seat: RoomSeat = {
      seatIndex: 0,
      playerId,
      displayName: input.displayName,
      ready: false,
      connected: false,
      joinedAt: createdAt,
      leftAt: null,
      disconnectedAt: null,
      reconnectDeadline: null,
    };
    const room: Room = {
      roomCode,
      createdAt,
      updatedAt: createdAt,
      status: 'LOBBY',
      hostSeatIndex: 0,
      maxPlayers: input.maxPlayers,
      rulesVariant: 'canonical',
      initialRevealCount: 2,
      maxScore: this.config.GAME_END_SCORE,
      maxRounds: 0,
      seats: Array.from({ length: input.maxPlayers }, (_, i) => (i === 0 ? seat : null)),
      game: null,
      actionQueue: Promise.resolve(),
      idempotencyCache: new Map(),
      persistedGameId: null,
      persistedGameEnded: false,
      persistedRoundStarts: new Set(),
      persistedRoundEnds: new Set(),
    };
    this.rooms.set(roomCode, room);
    this.metrics.activeRooms = this.rooms.size;
    await this.storage.upsertRoom({
      roomCode,
      status: room.status,
      settingsJson: {
        maxPlayers: room.maxPlayers,
        rulesVariant: room.rulesVariant,
        initialRevealCount: room.initialRevealCount,
        maxScore: room.maxScore,
        maxRounds: room.maxRounds,
      },
    });
    await this.storage.upsertRoomPlayer({
      roomCode,
      playerId,
      displayName: seat.displayName,
      seatIndex: seat.seatIndex,
    });
    const playerToken = signPlayerToken({ roomCode, playerId, seatIndex: 0 }, this.config.TOKEN_SECRET);
    return { roomCode, playerToken };
  }

  async joinRoom(input: JoinRoomInput): Promise<{ roomCode: string; playerToken: string }> {
    const roomCode = normalizeRoomCode(input.roomCode);
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new AppError('ROOM_NOT_FOUND', 'Room not found', 404);
    }
    if (room.status !== 'LOBBY') {
      throw new AppError('ROOM_NOT_JOINABLE', 'Room is no longer joinable', 409);
    }
    const seatIndex = room.seats.findIndex((seat) => seat === null || seat.leftAt !== null);
    if (seatIndex === -1) {
      throw new AppError('ROOM_FULL', 'Room is full', 409);
    }
    const playerId = randomUUID();
    const seat: RoomSeat = {
      seatIndex,
      playerId,
      displayName: input.displayName,
      ready: false,
      connected: false,
      joinedAt: nowMs(),
      leftAt: null,
      disconnectedAt: null,
      reconnectDeadline: null,
    };
    room.seats[seatIndex] = seat;
    room.updatedAt = nowMs();
    room.hostSeatIndex = this.computeHostSeat(room);
    await this.storage.upsertRoomPlayer({ roomCode, playerId, displayName: input.displayName, seatIndex });
    await this.persistRoomMeta(room);
    this.broadcastRoomEvent(room, 'room.playerJoined', {
      seatIndex,
      displayName: input.displayName,
      playerId,
    });
    this.broadcastSnapshot(room);
    const playerToken = signPlayerToken({ roomCode, playerId, seatIndex }, this.config.TOKEN_SECRET);
    return { roomCode, playerToken };
  }

  getRoomPublicState(code: string): RoomPublicState {
    const room = this.rooms.get(normalizeRoomCode(code));
    if (!room) {
      throw new AppError('ROOM_NOT_FOUND', 'Room not found', 404);
    }
    return toRoomPublicState(room);
  }

  private computeHostSeat(room: Room): number | null {
    const active = room.seats.filter((s): s is RoomSeat => Boolean(s)).filter((s) => s.leftAt === null);
    if (active.length === 0) {
      return null;
    }
    return active.sort((a, b) => a.seatIndex - b.seatIndex)[0]!.seatIndex;
  }

  private roomRng(room: Room, roundNumberHint: number): (() => number) | undefined {
    if (!this.config.RNG_SEED) {
      return undefined;
    }
    return seededRngFromString(`${this.config.RNG_SEED}:${room.roomCode}:${roundNumberHint}`);
  }

  private sendEnvelope(conn: ClientConnection, envelope: ServerWsEnvelope): void {
    if (conn.ws.readyState !== 1) {
      return;
    }
    conn.ws.send(JSON.stringify(envelope));
    this.metrics.wsMessagesSent += 1;
  }

  private sendEvent(conn: ClientConnection, event: string, payload: Record<string, unknown>): void {
    this.sendEnvelope(conn, { type: 'event', event, payload });
  }

  private getConnectedRoomClients(room: Room): ClientConnection[] {
    return [...this.connections.values()].filter((conn) => conn.authed && conn.roomCode === room.roomCode);
  }

  private broadcastRoomEvent(room: Room, event: string, payload: Record<string, unknown>): void {
    for (const conn of this.getConnectedRoomClients(room)) {
      this.sendEvent(conn, event, payload);
    }
  }

  private buildSnapshotPayload(room: Room, viewerSeat: number | null): Record<string, unknown> {
    const publicRoom = toRoomPublicState(room);
    const privateAddon = viewerSeat === null
      ? null
      : room.game
        ? toPrivateAddon(room.game, viewerSeat)
        : {
            seatIndex: viewerSeat,
            hiddenValues: [],
            pendingDrawnCard: null,
          };
    return {
      protocolVersion: 1,
      room: publicRoom,
      private: privateAddon,
    };
  }

  private broadcastSnapshot(room: Room): void {
    for (const conn of this.getConnectedRoomClients(room)) {
      this.sendEvent(conn, 'room.snapshot', this.buildSnapshotPayload(room, conn.seatIndex));
    }
  }

  private async persistRoomMeta(room: Room): Promise<void> {
    await this.storage.upsertRoom({
      roomCode: room.roomCode,
      status: room.status,
      settingsJson: {
        maxPlayers: room.maxPlayers,
        rulesVariant: room.rulesVariant,
        hostSeatIndex: room.hostSeatIndex,
        initialRevealCount: room.initialRevealCount,
        maxScore: room.maxScore,
        maxRounds: room.maxRounds,
      },
    });
  }

  private async persistGameTransitions(room: Room, prevGame: SkyjoGameState | null): Promise<void> {
    const game = room.game;
    if (!game) {
      await this.persistRoomMeta(room);
      return;
    }

    if (room.persistedGameId !== game.gameId) {
      room.persistedGameId = game.gameId;
      room.persistedGameEnded = false;
      room.persistedRoundStarts.clear();
      room.persistedRoundEnds.clear();
      await this.storage.insertGameStarted({
        gameId: game.gameId,
        roomCode: room.roomCode,
        startedAt: new Date(game.roundStartedAt),
        rulesVariant: game.rulesVariant,
      });
    }

    if (!room.persistedRoundStarts.has(game.roundId)) {
      room.persistedRoundStarts.add(game.roundId);
      await this.storage.insertRoundStarted({
        roundId: game.roundId,
        gameId: game.gameId,
        roundNumber: game.roundNumber,
        startedAt: new Date(game.roundStartedAt),
      });
    }

    if (game.completedRound && !room.persistedRoundEnds.has(game.completedRound.roundId)) {
      room.persistedRoundEnds.add(game.completedRound.roundId);
      await this.storage.updateRoundEnded({ roundId: game.completedRound.roundId, endedAt: new Date(game.completedRound.endedAt) });
      for (const score of game.completedRound.scores) {
        await this.storage.upsertRoundScore({
          roundId: game.completedRound.roundId,
          seatIndex: score.seatIndex,
          score: score.score,
          doubled: score.doubled,
        });
      }
    }

    if (game.phase === 'GAME_ENDED' && !room.persistedGameEnded) {
      room.persistedGameEnded = true;
      await this.storage.updateGameEnded({
        gameId: game.gameId,
        endedAt: new Date(game.completedRound?.endedAt ?? nowMs()),
        winnerSeatIndex: game.winnerSeatIndex ?? 0,
      });
    }

    if (!prevGame || prevGame.roundId !== game.roundId || prevGame.phase !== game.phase) {
      await this.persistRoomMeta(room);
    }
  }

  private pruneCaches(room: Room, conn?: ClientConnection): void {
    const cutoff = nowMs();
    for (const [key, entry] of room.idempotencyCache) {
      if (entry.expiresAt <= cutoff) room.idempotencyCache.delete(key);
    }
    if (conn) {
      for (const [key, entry] of conn.requestCache) {
        if (entry.expiresAt <= cutoff) conn.requestCache.delete(key);
      }
    }
  }

  private async enqueueRoomTask<T>(room: Room, task: () => Promise<T>): Promise<T> {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const out = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    room.actionQueue = room.actionQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          resolvePromise(await task());
        } catch (error) {
          rejectPromise(error);
        }
      });
    return out;
  }

  async tryAuthenticateConnection(conn: ClientConnection, token: string): Promise<void> {
    let payload: PlayerTokenPayload;
    try {
      payload = verifyPlayerToken(token, this.config.TOKEN_SECRET);
    } catch {
      throw new AppError('AUTH_INVALID_TOKEN', 'Invalid player token', 401);
    }

    const room = this.rooms.get(normalizeRoomCode(payload.roomCode));
    if (!room) {
      throw new AppError('ROOM_NOT_FOUND', 'Room not found', 404);
    }
    const seat = room.seats[payload.seatIndex];
    if (!seat || seat.leftAt !== null || seat.playerId !== payload.playerId) {
      throw new AppError('SEAT_NOT_FOUND', 'Seat no longer available', 401);
    }

    if (!seat.connected && seat.reconnectDeadline && nowMs() > seat.reconnectDeadline) {
      throw new AppError('RECONNECT_WINDOW_EXPIRED', 'Reconnect window has expired', 401);
    }

    // Close any prior live connection for this seat.
    for (const other of this.getConnectedRoomClients(room)) {
      if (other.seatIndex === seat.seatIndex && other.id !== conn.id) {
        try {
          other.ws.close(4001, 'Superseded by new connection');
        } catch {
          // ignore
        }
      }
    }

    conn.authed = true;
    conn.roomCode = room.roomCode;
    conn.playerId = seat.playerId;
    conn.seatIndex = seat.seatIndex;
    seat.connected = true;
    seat.disconnectedAt = null;
    seat.reconnectDeadline = null;
    room.updatedAt = nowMs();
    if (room.game) {
      room.game = setPlayerConnected(room.game, seat.seatIndex, true);
      room.status = roomStatusFromGame(room.game);
      await this.persistGameTransitions(room, room.game);
    }
    await this.persistRoomMeta(room);

    this.sendEvent(conn, 'hello', this.buildSnapshotPayload(room, seat.seatIndex));
    this.broadcastRoomEvent(room, 'room.playerJoined', { seatIndex: seat.seatIndex, reconnected: true });
    this.broadcastSnapshot(room);
  }

  async handleRawMessage(conn: ClientConnection, raw: RawData): Promise<void> {
    this.metrics.wsMessagesReceived += 1;
    const now = nowMs();
    if (now - conn.wsWindowStartedAt >= 1000) {
      conn.wsWindowStartedAt = now;
      conn.wsWindowCount = 0;
    }
    conn.wsWindowCount += 1;
    if (conn.wsWindowCount > this.config.WS_MESSAGES_PER_SECOND) {
      this.sendEnvelope(conn, createErrorEnvelope('rate-limit', 'RATE_LIMITED', 'Too many WebSocket messages'));
      try {
        conn.ws.close(4408, 'Rate limited');
      } catch {
        // ignore
      }
      return;
    }
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof Buffer) text = raw.toString('utf8');
    else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
    else if (raw instanceof ArrayBuffer) text = Buffer.from(new Uint8Array(raw)).toString('utf8');
    else if (ArrayBuffer.isView(raw)) text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    else text = String(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendEnvelope(conn, createErrorEnvelope('unknown', 'BAD_JSON', 'Invalid JSON'));
      return;
    }

    const envelopeParsed = ClientEnvelopeSchema.safeParse(parsed);
    if (!envelopeParsed.success) {
      this.sendEnvelope(conn, createErrorEnvelope('unknown', 'INVALID_ENVELOPE', 'Invalid message envelope', envelopeParsed.error.flatten()));
      return;
    }
    const envelope = envelopeParsed.data;
    if (conn.roomCode) {
      const maybeRoom = this.rooms.get(conn.roomCode);
      if (maybeRoom) {
        this.pruneCaches(maybeRoom, conn);
      } else {
        this.pruneCaches({ idempotencyCache: new Map() } as Room, conn);
      }
    } else {
      this.pruneCaches({ idempotencyCache: new Map() } as Room, conn);
    }

    const cachedConnResponse = conn.requestCache.get(envelope.requestId);
    if (cachedConnResponse) {
      this.sendEnvelope(conn, cachedConnResponse.response);
      return;
    }

    if (!conn.authed) {
      await this.handleUnauthedMessage(conn, envelope);
      return;
    }

    const room = this.rooms.get(conn.roomCode!);
    if (!room) {
      const resp = createErrorEnvelope(envelope.requestId, 'ROOM_NOT_FOUND', 'Room not found');
      this.cacheConnResponse(conn, envelope.requestId, resp);
      this.sendEnvelope(conn, resp);
      return;
    }

    await this.enqueueRoomTask(room, async () => {
      this.pruneCaches(room, conn);
      const cacheKey = seatCacheKey(conn.seatIndex!, envelope.requestId);
      const cached = room.idempotencyCache.get(cacheKey);
      if (cached) {
        this.sendEnvelope(conn, cached.response);
        return;
      }

      let response: ServerWsEnvelope;
      try {
        response = await this.handleAuthedEnvelope(room, conn, envelope);
      } catch (error) {
        this.metrics.actionErrors += 1;
        if (error instanceof AppError) {
          response = createErrorEnvelope(envelope.requestId, error.code, error.message, error.details);
        } else if (error instanceof GameRuleError) {
          response = createErrorEnvelope(envelope.requestId, error.code, error.message, error.details);
        } else if (error instanceof z.ZodError) {
          response = createErrorEnvelope(envelope.requestId, 'VALIDATION_ERROR', 'Invalid payload', error.flatten());
        } else {
          this.logger.error({ err: error, requestId: envelope.requestId, roomCode: room.roomCode }, 'ws action failed');
          response = createErrorEnvelope(envelope.requestId, 'INTERNAL_ERROR', 'Internal server error');
        }
      }

      room.idempotencyCache.set(cacheKey, {
        expiresAt: nowMs() + this.config.ACTION_REQUEST_TTL_SECONDS * 1000,
        response,
      });
      this.sendEnvelope(conn, response);
    });
  }

  private cacheConnResponse(conn: ClientConnection, requestId: string, response: ServerWsEnvelope): void {
    conn.requestCache.set(requestId, {
      expiresAt: nowMs() + this.config.ACTION_REQUEST_TTL_SECONDS * 1000,
      response,
    });
  }

  private async handleUnauthedMessage(conn: ClientConnection, envelope: z.infer<typeof ClientEnvelopeSchema>): Promise<void> {
    if (envelope.type !== 'auth') {
      const resp = createErrorEnvelope(envelope.requestId, 'AUTH_REQUIRED', 'Authenticate first');
      this.cacheConnResponse(conn, envelope.requestId, resp);
      this.sendEnvelope(conn, resp);
      return;
    }
    const payload = AuthPayloadSchema.parse(envelope.payload);
    try {
      await this.tryAuthenticateConnection(conn, payload.token);
      const resp = createOkEnvelope(envelope.requestId, {});
      this.cacheConnResponse(conn, envelope.requestId, resp);
      this.sendEnvelope(conn, resp);
    } catch (error) {
      const resp = error instanceof AppError
        ? createErrorEnvelope(envelope.requestId, error.code, error.message, error.details)
        : createErrorEnvelope(envelope.requestId, 'AUTH_FAILED', 'Authentication failed');
      this.cacheConnResponse(conn, envelope.requestId, resp);
      this.sendEnvelope(conn, resp);
    }
  }

  private async handleAuthedEnvelope(
    room: Room,
    conn: ClientConnection,
    envelope: z.infer<typeof ClientEnvelopeSchema>,
  ): Promise<ServerWsEnvelope> {
    const seatIndex = conn.seatIndex!;
    const seat = room.seats[seatIndex];
    if (!seat || seat.playerId !== conn.playerId) {
      throw new AppError('SEAT_NOT_FOUND', 'Seat not found', 401);
    }

    this.logger.info({ requestId: envelope.requestId, roomCode: room.roomCode, seatIndex, action: envelope.type }, 'ws action');
    room.updatedAt = nowMs();

    switch (envelope.type) {
      case 'room.ready': {
        const payload = RoomReadyPayloadSchema.parse(envelope.payload);
        if (room.status !== 'LOBBY') {
          throw new AppError('INVALID_PHASE', 'Ready can only be changed in lobby', 409);
        }
        seat.ready = payload.ready;
        await this.persistRoomMeta(room);
        this.broadcastRoomEvent(room, 'room.readyStatus', { seatIndex, ready: seat.ready });
        this.broadcastSnapshot(room);
        return createOkEnvelope(envelope.requestId, { ready: seat.ready });
      }
      case 'room.settings': {
        const payload = RoomSettingsPayloadSchema.parse(envelope.payload);
        if (room.status !== 'LOBBY') {
          throw new AppError('INVALID_PHASE', 'Room settings can only be changed in lobby', 409);
        }
        if (room.hostSeatIndex !== seatIndex) {
          throw new AppError('FORBIDDEN', 'Only host can update room settings', 403);
        }
        if (payload.initialRevealCount !== undefined) {
          room.initialRevealCount = payload.initialRevealCount;
        }
        if (payload.maxScore !== undefined) {
          room.maxScore = payload.maxScore;
        }
        if (payload.maxRounds !== undefined) {
          room.maxRounds = payload.maxRounds;
        }
        await this.persistRoomMeta(room);
        this.broadcastRoomEvent(room, 'room.settingsUpdated', {
          initialRevealCount: room.initialRevealCount,
          maxScore: room.maxScore,
          maxRounds: room.maxRounds,
        });
        this.broadcastSnapshot(room);
        return createOkEnvelope(envelope.requestId, {
          initialRevealCount: room.initialRevealCount,
          maxScore: room.maxScore,
          maxRounds: room.maxRounds,
        });
      }
      case 'room.leave': {
        await this.handleLeave(room, seatIndex);
        this.broadcastSnapshot(room);
        return createOkEnvelope(envelope.requestId, {});
      }
      case 'room.start': {
        if (room.hostSeatIndex !== seatIndex) {
          throw new AppError('FORBIDDEN', 'Only host can start', 403);
        }
        await this.handleRoomStart(room);
        return createOkEnvelope(envelope.requestId, { status: room.status });
      }
      default:
        return this.handleGameEnvelope(room, conn, envelope);
    }
  }

  private async handleLeave(room: Room, seatIndex: number): Promise<void> {
    const seat = room.seats[seatIndex];
    if (!seat) {
      return;
    }
    if (room.game) {
      seat.connected = false;
      seat.disconnectedAt = nowMs();
      seat.reconnectDeadline = nowMs() + this.config.RECONNECT_GRACE_SECONDS * 1000;
      room.game = setPlayerConnected(room.game, seatIndex, false);
      room.status = roomStatusFromGame(room.game);
      this.broadcastRoomEvent(room, 'room.playerLeft', { seatIndex, disconnected: true });
      await this.persistRoomMeta(room);
      return;
    }
    seat.leftAt = nowMs();
    seat.connected = false;
    seat.ready = false;
    await this.storage.markPlayerLeft(room.roomCode, seat.playerId, new Date(seat.leftAt));
    room.hostSeatIndex = this.computeHostSeat(room);
    await this.persistRoomMeta(room);
    this.broadcastRoomEvent(room, 'room.playerLeft', { seatIndex, disconnected: false });
    this.broadcastRoomEvent(room, 'room.hostChanged', { hostSeatIndex: room.hostSeatIndex });
  }

  private async handleRoomStart(room: Room): Promise<void> {
    const activeSeats = room.seats.filter((s): s is RoomSeat => Boolean(s)).filter((s) => s.leftAt === null);
    if (activeSeats.length < 2) {
      throw new AppError('MIN_PLAYERS', 'At least 2 players required', 409);
    }
    if (room.status === 'LOBBY') {
      if (activeSeats.some((s) => !s.ready)) {
        throw new AppError('NOT_READY', 'All players must be ready', 409);
      }
      const transition = createGame(
        activeSeats.map((s) => ({
          seatIndex: s.seatIndex,
          playerId: s.playerId,
          displayName: s.displayName,
          connected: s.connected,
        })),
        {
          targetScore: room.maxScore,
          maxRounds: room.maxRounds,
          rng: this.roomRng(room, 1),
          initialRevealCount: room.initialRevealCount,
        },
      );
      room.game = transition.state;
      for (const seat of activeSeats) {
        seat.ready = false;
      }
      room.status = roomStatusFromGame(room.game);
      await this.persistGameTransitions(room, null);
      await this.persistEngineEvents(room, transition.events);
      this.broadcastEngineTransition(room, transition);
      return;
    }
    if (room.status === 'ROUND_END') {
      if (!room.game) throw new AppError('NO_GAME', 'No game in progress', 409);
      const prev = room.game;
      const transition = startNextRound(room.game, {
        targetScore: room.maxScore,
        maxRounds: room.maxRounds,
        rng: this.roomRng(room, room.game.roundNumber + 1),
        initialRevealCount: room.initialRevealCount,
      });
      room.game = transition.state;
      room.status = roomStatusFromGame(room.game);
      await this.persistGameTransitions(room, prev);
      await this.persistEngineEvents(room, transition.events);
      this.broadcastEngineTransition(room, transition);
      return;
    }
    throw new AppError('INVALID_PHASE', 'Cannot start in current room status', 409);
  }

  private async persistEngineEvents(room: Room, events: Array<{ event: string; payload: Record<string, unknown> }>): Promise<void> {
    for (const ev of events) {
      await this.storage.insertEvent(room.roomCode, ev.event, ev.payload);
    }
  }

  private broadcastEngineTransition(
    room: Room,
    transition: { events: Array<{ event: string; payload: Record<string, unknown> }>; privateEventsBySeat: Record<number, Array<{ event: string; payload: Record<string, unknown> }>> },
  ): void {
    for (const ev of transition.events) {
      this.broadcastRoomEvent(room, ev.event, ev.payload);
    }
    for (const [seatStr, events] of Object.entries(transition.privateEventsBySeat)) {
      const seatIndex = Number(seatStr);
      for (const conn of this.getConnectedRoomClients(room).filter((c) => c.seatIndex === seatIndex)) {
        for (const ev of events) {
          this.sendEvent(conn, ev.event, ev.payload);
        }
      }
    }
    this.broadcastSnapshot(room);
  }

  private async handleGameEnvelope(
    room: Room,
    conn: ClientConnection,
    envelope: z.infer<typeof ClientEnvelopeSchema>,
  ): Promise<ServerWsEnvelope> {
    if (!room.game) {
      throw new AppError('NO_GAME', 'Game has not started', 409);
    }
    if (envelope.type === 'game.confirmEndRound' && room.hostSeatIndex !== conn.seatIndex) {
      throw new AppError('FORBIDDEN', 'Only host can confirm round summary', 403);
    }

    const prevGame = room.game;
    let drawDeckValue: number | null = null;

    if (envelope.type === 'game.drawDeck') {
      DrawDeckPayloadSchema.parse(envelope.payload);
      const transition = applyAction(room.game, { type: 'game.drawDeck', seatIndex: conn.seatIndex! });
      room.game = transition.state;
      room.status = roomStatusFromGame(room.game);
      const privateDraw = transition.privateEventsBySeat[conn.seatIndex!]?.find((e) => e.event === 'game.cardDrawnPrivate');
      drawDeckValue = typeof privateDraw?.payload.value === 'number' ? (privateDraw.payload.value as number) : null;
      await this.persistGameTransitions(room, prevGame);
      await this.persistEngineEvents(room, transition.events);
      this.broadcastEngineTransition(room, transition);
      return createOkEnvelope(envelope.requestId, drawDeckValue === null ? {} : { drawnCard: drawDeckValue });
    }

    const engineAction = this.parseEngineAction(conn.seatIndex!, envelope);
    const transition = applyAction(room.game, engineAction);
    room.game = transition.state;
    room.status = roomStatusFromGame(room.game);
    await this.persistGameTransitions(room, prevGame);
    await this.persistEngineEvents(room, transition.events);
    this.broadcastEngineTransition(room, transition);
    return createOkEnvelope(envelope.requestId, {});
  }

  private parseEngineAction(seatIndex: number, envelope: z.infer<typeof ClientEnvelopeSchema>) {
    switch (envelope.type) {
      case 'game.revealInitial': {
        const payload = RevealInitialPayloadSchema.parse(envelope.payload);
        return { type: 'game.revealInitial' as const, seatIndex, positions: payload.positions };
      }
      case 'game.takeDiscard': {
        DrawDeckPayloadSchema.parse(envelope.payload);
        return { type: 'game.takeDiscard' as const, seatIndex };
      }
      case 'game.confirmEndRound': {
        ConfirmEndRoundPayloadSchema.parse(envelope.payload);
        return { type: 'game.confirmEndRound' as const, seatIndex };
      }
      case 'game.swapDrawn': {
        const payload = TargetPosPayloadSchema.parse(envelope.payload);
        return { type: 'game.swapDrawn' as const, seatIndex, targetPosition: payload.targetPosition };
      }
      case 'game.discardDrawnAndReveal': {
        const payload = DiscardDrawnAndRevealPayloadSchema.parse(envelope.payload);
        return { type: 'game.discardDrawnAndReveal' as const, seatIndex, revealPosition: payload.revealPosition };
      }
      case 'game.discardColumn': {
        const payload = DiscardColumnPayloadSchema.parse(envelope.payload);
        return { type: 'game.discardColumn' as const, seatIndex, columnIndex: payload.columnIndex };
      }
      case 'game.passColumnDiscard': {
        return { type: 'game.passColumnDiscard' as const, seatIndex };
      }
      default:
        throw new AppError('UNKNOWN_ACTION', `Unsupported action ${envelope.type}`, 400);
    }
  }

  private heartbeatSweep(): void {
    for (const conn of this.connections.values()) {
      if (!conn.isAlive) {
        try {
          conn.ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        // ignore
      }
    }

    this.logger.info(
      {
        activeRooms: this.rooms.size,
        activeConnections: this.connections.size,
        wsMessagesReceived: this.metrics.wsMessagesReceived,
        wsMessagesSent: this.metrics.wsMessagesSent,
        actionErrors: this.metrics.actionErrors,
      },
      'metrics',
    );
  }

  private cleanupIdleRooms(): void {
    const ttlMs = this.config.ROOM_IDLE_TTL_MINUTES * 60_000;
    const now = nowMs();
    for (const [roomCode, room] of this.rooms) {
      if (now - room.updatedAt <= ttlMs) {
        continue;
      }
      this.logger.info({ roomCode }, 'cleaning idle room');
      this.broadcastRoomEvent(room, 'room.closed', { reason: 'idle_ttl' });
      for (const conn of this.getConnectedRoomClients(room)) {
        try {
          conn.ws.close(4000, 'Room idle timeout');
        } catch {
          // ignore
        }
      }
      this.rooms.delete(roomCode);
    }
    this.metrics.activeRooms = this.rooms.size;
  }
}
