import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type AppContext } from '../../src/server/app';
import type { AppConfig } from '../../src/config/env';
import { NoopStorage } from '../../src/storage/noop';

type Envelope = any;

type SnapshotPayload = {
  protocolVersion: number;
  room: any;
  private: any;
};

class WsTestClient {
  public ws!: WebSocket;
  public events: Envelope[] = [];
  public responses = new Map<string, Envelope>();
  public pendingResponses = new Map<string, (env: Envelope) => void>();
  public latestSnapshot: SnapshotPayload | null = null;
  private waiters: Array<{ event?: string; resolve: (env: Envelope) => void }> = [];
  private nextRequest = 1;
  private readonly requestPrefix = Math.random().toString(36).slice(2, 8);

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.type === 'response') {
        this.responses.set(env.requestId, env);
        const waiter = this.pendingResponses.get(env.requestId);
        if (waiter) {
          this.pendingResponses.delete(env.requestId);
          waiter(env);
        }
      }
      if (env.type === 'event') {
        this.events.push(env);
        if (env.event === 'hello' || env.event === 'room.snapshot') {
          this.latestSnapshot = env.payload;
        }
        for (let i = 0; i < this.waiters.length; i += 1) {
          const waiter = this.waiters[i]!;
          if (!waiter.event || waiter.event === env.event) {
            this.waiters.splice(i, 1);
            waiter.resolve(env);
            break;
          }
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
  }

  waitForEvent(event?: string, timeoutMs = 5000): Promise<Envelope> {
    const existing = [...this.events].reverse().find((e) => !event || e.event === event);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for event ${event ?? '*'} `)), timeoutMs);
      this.waiters.push({
        event,
        resolve: (env) => {
          clearTimeout(timer);
          resolve(env);
        },
      });
    });
  }

  send(type: string, payload: Record<string, unknown> = {}, requestId?: string): Promise<Envelope> {
    const rid = requestId ?? `${this.requestPrefix}-r${this.nextRequest++}`;
    const env = { type, requestId: rid, payload };
    this.ws.send(JSON.stringify(env));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for response ${rid}`)), 5000);
      this.pendingResponses.set(rid, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

function mkConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'error',
    ROOM_IDLE_TTL_MINUTES: 30,
    RECONNECT_GRACE_SECONDS: 120,
    WS_HEARTBEAT_SECONDS: 60,
    WS_MAX_MESSAGE_BYTES: 16_384,
    WS_MESSAGES_PER_SECOND: 60,
    WS_CONNECTION_RATE_LIMIT_PER_MINUTE: 1000,
    ACTION_REQUEST_TTL_SECONDS: 120,
    CREATE_JOIN_RATE_LIMIT_PER_MINUTE: 1000,
    ROOM_LOOKUP_RATE_LIMIT_PER_MINUTE: 1000,
    METRICS_RATE_LIMIT_PER_MINUTE: 1000,
    GAME_END_SCORE: 1,
    TOKEN_SECRET: 'test-secret-123',
    DEBUG_LOG_HIDDEN_CARDS: false,
    ENABLE_DB: true,
    RNG_SEED: 'integration-seed',
  };
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function startTestApp(configOverrides: Partial<AppConfig> = {}): Promise<{
  ctx: AppContext;
  baseUrl: string;
  storage: NoopStorage;
}> {
  const storage = new NoopStorage();
  const ctx = await buildApp({ config: { ...mkConfig(), ...configOverrides }, storage });
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = ctx.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  return { ctx, baseUrl: `http://127.0.0.1:${addr.port}`, storage };
}

async function expectWsUpgradeRejected(url: string): Promise<number> {
  const ws = new WebSocket(url);
  return await new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once('open', () => {
      reject(new Error('expected websocket upgrade to be rejected'));
      void ws.close();
    });
    ws.once('error', () => {
      // `unexpected-response` is the assertion path we care about.
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function getSeatClient(clients: Record<number, WsTestClient>, seatIndex: number): WsTestClient {
  const client = clients[seatIndex];
  if (!client) throw new Error(`missing client for seat ${seatIndex}`);
  return client;
}

function firstHiddenPosition(snapshot: SnapshotPayload, seatIndex: number): number | null {
  const slots = snapshot.room.game.players.find((p: any) => p.seatIndex === seatIndex)?.layout ?? [];
  const hidden = slots.find((s: any) => !s.removed && !s.revealed);
  return hidden ? hidden.position : null;
}

async function driveOneAction(clients: Record<number, WsTestClient>, hostSeat: number): Promise<void> {
  const snapshot = clients[hostSeat].latestSnapshot!;
  const room = snapshot.room;
  const game = room.game;
  if (!game) throw new Error('no game');

  if (room.status === 'ROUND_END') {
    await getSeatClient(clients, hostSeat).send('room.start', {});
    return;
  }

  if (room.status === 'GAME_END') {
    return;
  }

  if (game.phase === 'WAITING_INITIAL_REVEALS') {
    const requiredInitialRevealCount =
      (typeof game.initialRevealCount === 'number' ? game.initialRevealCount : null) ??
      (typeof room.initialRevealCount === 'number' ? room.initialRevealCount : null) ??
      2;
    for (const p of game.players) {
      const revealedCount = p.layout.filter((s: any) => s.revealed).length;
      if (revealedCount < requiredInitialRevealCount) {
        const client = getSeatClient(clients, p.seatIndex);
        await client.send(
          'game.revealInitial',
          { positions: Array.from({ length: requiredInitialRevealCount }, (_, i) => i) },
        );
        return;
      }
    }
    return;
  }

  if (game.phase === 'ROUND_REVEAL_PENDING_SUMMARY') {
    await getSeatClient(clients, hostSeat).send('game.confirmEndRound', {});
    return;
  }

  const seat = game.currentTurnSeat;
  const client = getSeatClient(clients, seat);
  if (game.turnStage === 'AWAITING_COLUMN_DECISION') {
    await client.send('game.passColumnDiscard', {});
    return;
  }

  if (game.turnStage === 'DRAWN_PENDING') {
    const target = firstHiddenPosition(client.latestSnapshot!, seat) ?? 0;
    await client.send('game.swapDrawn', { targetPosition: target });
    return;
  }

  if (game.turnStage === 'AWAITING_ACTION') {
    // Exercise both deck and discard paths.
    const useDeck = (client.events.filter((e) => e.event === 'game.cardDrawnPrivate').length % 2) === 0;
    if (useDeck) {
      const drawResp = await client.send('game.drawDeck', {});
      expect(drawResp.ok).toBe(true);
      expect(typeof drawResp.payload.drawnCard).toBe('number');
      return;
    }
    await client.send('game.takeDiscard', {});
    return;
  }

  throw new Error(`Unhandled turn stage ${game.turnStage}`);
}

describe('server integration', () => {
  let ctx: AppContext;
  let baseUrl: string;
  let storage: NoopStorage;

  beforeAll(async () => {
    storage = new NoopStorage();
    ctx = await buildApp({ config: mkConfig(), storage });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = ctx.app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.close();
    }
  });

  it('creates, joins, starts, plays, reconnects, and persists game results', async () => {
    const create = await postJson(`${baseUrl}/v1/rooms`, {
      displayName: 'Host',
      maxPlayers: 2,
      rulesVariant: 'canonical',
    });
    expect(create.status).toBe(201);
    const roomCode = create.json.roomCode as string;
    const hostToken = create.json.playerToken as string;

    const join = await postJson(`${baseUrl}/v1/rooms/${roomCode}/join`, { displayName: 'Guest' });
    expect(join.status).toBe(200);
    const guestToken = join.json.playerToken as string;

    const publicStateRes = await fetch(`${baseUrl}/v1/rooms/${roomCode}`);
    expect(publicStateRes.status).toBe(200);
    const publicState = await publicStateRes.json();
    expect(publicState.players).toHaveLength(2);
    expect(publicState.game).toBeNull();

    const wsBase = create.json.wsUrl as string;
    const host = new WsTestClient(`${wsBase}?token=${encodeURIComponent(hostToken)}`);
    const guest = new WsTestClient(`${wsBase}?token=${encodeURIComponent(guestToken)}`);
    await host.connect();
    await guest.connect();
    await host.waitForEvent('hello');
    await guest.waitForEvent('hello');

    await host.send('room.ready', { ready: true });
    await guest.send('room.ready', { ready: true });
    const startResp = await host.send('room.start', {});
    expect(startResp.ok).toBe(true);

    await waitUntil(
      () =>
        Boolean(host.latestSnapshot?.room.game) &&
        Boolean(guest.latestSnapshot?.room.game) &&
        Boolean(host.latestSnapshot?.private) &&
        Boolean(guest.latestSnapshot?.private),
    );
    expect(host.latestSnapshot?.room.status).toBe('IN_ROUND');

    const clientsBySeat: Record<number, WsTestClient> = {};
    for (const client of [host, guest]) {
      const seatIndex = client.latestSnapshot!.private.seatIndex as number;
      clientsBySeat[seatIndex] = client;
    }
    const hostSeat = host.latestSnapshot!.private.seatIndex as number;

    // Perform a few actions, then reconnect one client.
    for (let i = 0; i < 6; i += 1) {
      await driveOneAction(clientsBySeat, hostSeat);
      await waitUntil(() => Boolean(host.latestSnapshot?.room));
    }

    const guestSeat = guest.latestSnapshot!.private.seatIndex as number;
    await guest.close();
    delete clientsBySeat[guestSeat];

    const guestReconnected = new WsTestClient(`${wsBase}?token=${encodeURIComponent(guestToken)}`);
    await guestReconnected.connect();
    const hello = await guestReconnected.waitForEvent('hello');
    expect(hello.payload.private.seatIndex).toBe(guestSeat);
    clientsBySeat[guestSeat] = guestReconnected;

    let safety = 0;
    while ((host.latestSnapshot?.room.status !== 'GAME_END') && safety < 400) {
      await driveOneAction(clientsBySeat, hostSeat);
      await waitUntil(() => Boolean(host.latestSnapshot?.room.status));
      safety += 1;
    }
    expect(host.latestSnapshot?.room.status).toBe('GAME_END');

    const summaries = await ctx.storage.getGameSummariesByRoom(roomCode);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0]?.ended_at ?? summaries[0]?.endedAt).toBeTruthy();
    expect(storage.events.some((e) => e.eventType === 'game.roundScored')).toBe(true);
    expect(storage.events.some((e) => e.eventType === 'game.ended')).toBe(true);

    await host.close();
    await guestReconnected.close();
  });

  it('allows host to change lobby settings before game start', async () => {
    const create = await postJson(`${baseUrl}/v1/rooms`, {
      displayName: 'Host',
      maxPlayers: 2,
      rulesVariant: 'canonical',
    });
    expect(create.status).toBe(201);
    const roomCode = create.json.roomCode as string;
    const hostToken = create.json.playerToken as string;

    const join = await postJson(`${baseUrl}/v1/rooms/${roomCode}/join`, { displayName: 'Guest' });
    expect(join.status).toBe(200);
    const guestToken = join.json.playerToken as string;

    const wsBase = create.json.wsUrl as string;
    const host = new WsTestClient(`${wsBase}?token=${encodeURIComponent(hostToken)}`);
    const guest = new WsTestClient(`${wsBase}?token=${encodeURIComponent(guestToken)}`);
    await host.connect();
    await guest.connect();
    await host.waitForEvent('hello');
    await guest.waitForEvent('hello');

    const guestSettingsResp = await guest.send('room.settings', { initialRevealCount: 3 });
    expect(guestSettingsResp.ok).toBe(false);
    expect(guestSettingsResp.error.code).toBe('FORBIDDEN');

    const hostSettingsResp = await host.send('room.settings', { initialRevealCount: 3, maxScore: 150, maxRounds: 4 });
    expect(hostSettingsResp.ok).toBe(true);
    expect(hostSettingsResp.payload.initialRevealCount).toBe(3);
    expect(hostSettingsResp.payload.maxScore).toBe(150);
    expect(hostSettingsResp.payload.maxRounds).toBe(4);
    await waitUntil(
      () =>
          host.latestSnapshot?.room.initialRevealCount === 3 &&
          guest.latestSnapshot?.room.initialRevealCount === 3 &&
          host.latestSnapshot?.room.maxScore === 150 &&
          guest.latestSnapshot?.room.maxScore === 150 &&
          host.latestSnapshot?.room.maxRounds === 4 &&
          guest.latestSnapshot?.room.maxRounds === 4,
    );

    await host.send('room.ready', { ready: true });
    await guest.send('room.ready', { ready: true });
    await host.send('room.start', {});
    await waitUntil(() => host.latestSnapshot?.room.game != null && guest.latestSnapshot?.room.game != null);

    expect(host.latestSnapshot?.room.game.initialRevealCount).toBe(3);
    expect(host.latestSnapshot?.room.game.maxScore).toBe(150);
    expect(host.latestSnapshot?.room.game.maxRounds).toBe(4);

    const invalidReveal = await host.send('game.revealInitial', { positions: [0, 1] });
    expect(invalidReveal.ok).toBe(false);
    expect(invalidReveal.error.code).toBe('INITIAL_REVEAL_COUNT');

    const validReveal = await host.send('game.revealInitial', { positions: [0, 1, 2] });
    expect(validReveal.ok).toBe(true);

    await host.close();
    await guest.close();
  });

  it('rate limits repeated public room lookups', async () => {
    const temp = await startTestApp({ ROOM_LOOKUP_RATE_LIMIT_PER_MINUTE: 1 });
    try {
      const create = await postJson(`${temp.baseUrl}/v1/rooms`, {
        displayName: 'Host',
        maxPlayers: 2,
        rulesVariant: 'canonical',
      });
      expect(create.status).toBe(201);
      const roomCode = create.json.roomCode as string;

      const first = await fetch(`${temp.baseUrl}/v1/rooms/${roomCode}`);
      expect(first.status).toBe(200);

      const second = await fetch(`${temp.baseUrl}/v1/rooms/${roomCode}`);
      expect(second.status).toBe(429);
    } finally {
      await temp.ctx.close();
    }
  });

  it('rate limits websocket connection upgrades per client', async () => {
    const temp = await startTestApp({ WS_CONNECTION_RATE_LIMIT_PER_MINUTE: 1 });
    try {
      const create = await postJson(`${temp.baseUrl}/v1/rooms`, {
        displayName: 'Host',
        maxPlayers: 2,
        rulesVariant: 'canonical',
      });
      expect(create.status).toBe(201);
      const wsBase = create.json.wsUrl as string;
      const hostToken = create.json.playerToken as string;
      const wsUrl = `${wsBase}?token=${encodeURIComponent(hostToken)}`;

      const host = new WsTestClient(wsUrl);
      await host.connect();
      await host.waitForEvent('hello');

      const rejectedStatus = await expectWsUpgradeRejected(wsUrl);
      expect(rejectedStatus).toBe(429);

      await host.close();
    } finally {
      await temp.ctx.close();
    }
  });
});
