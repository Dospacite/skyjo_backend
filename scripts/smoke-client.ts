import WebSocket from 'ws';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const TURNS = Number(process.env.SMOKE_TURNS ?? 20);

class Client {
  ws!: WebSocket;
  latestSnapshot: any = null;
  private nextId = 1;
  private pending = new Map<string, (msg: any) => void>();

  constructor(public readonly url: string, public readonly name: string) {}

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'event' && (msg.event === 'hello' || msg.event === 'room.snapshot')) {
        this.latestSnapshot = msg.payload;
      }
      if (msg.type === 'response') {
        const waiter = this.pending.get(msg.requestId);
        if (waiter) {
          this.pending.delete(msg.requestId);
          waiter(msg);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => reject(e));
    });
    await this.waitForSnapshot();
  }

  async waitForSnapshot(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!this.latestSnapshot) {
      if (Date.now() - start > timeoutMs) throw new Error(`${this.name}: timeout waiting snapshot`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async send(type: string, payload: Record<string, unknown> = {}) {
    const requestId = `${this.name}-${this.nextId++}`;
    this.ws.send(JSON.stringify({ type, requestId, payload }));
    const res = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timeout ${type}`)), 5000);
      this.pending.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    if (!res.ok) {
      throw new Error(`${this.name}: ${type} failed ${res.error.code} ${res.error.message}`);
    }
    return res.payload;
  }

  close() {
    this.ws.close();
  }
}

async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function firstHiddenPos(client: Client): number | null {
  const seat = client.latestSnapshot?.private?.seatIndex;
  const slots = client.latestSnapshot?.room?.game?.players?.find((p: any) => p.seatIndex === seat)?.layout ?? [];
  const hidden = slots.find((s: any) => !s.removed && !s.revealed);
  return hidden ? hidden.position : null;
}

async function playStep(clientsBySeat: Record<number, Client>, hostSeat: number) {
  const snap = clientsBySeat[hostSeat].latestSnapshot;
  const room = snap.room;
  const game = room.game;

  if (room.status === 'ROUND_END') {
    await clientsBySeat[hostSeat].send('room.start', {});
    return;
  }
  if (room.status === 'GAME_END') return;

  if (game.phase === 'WAITING_INITIAL_REVEALS') {
    for (const p of game.players) {
      const revealed = p.layout.filter((s: any) => s.revealed).length;
      if (revealed < 2) {
        await clientsBySeat[p.seatIndex].send('game.revealInitial', { positions: [0, 1] });
        return;
      }
    }
    return;
  }

  const seat = game.currentTurnSeat;
  const client = clientsBySeat[seat];

  if (game.turnStage === 'AWAITING_COLUMN_DECISION') {
    await client.send('game.passColumnDiscard', {});
    return;
  }
  if (game.turnStage === 'DRAWN_PENDING') {
    await client.send('game.swapDrawn', { targetPosition: firstHiddenPos(client) ?? 0 });
    return;
  }
  if (game.turnStage === 'AWAITING_ACTION') {
    const target = firstHiddenPos(client) ?? 0;
    if (Math.random() < 0.5) {
      await client.send('game.drawDeck', {});
    } else {
      await client.send('game.takeDiscard', { targetPosition: target });
    }
    return;
  }
}

async function main() {
  const create = await postJson<{ roomCode: string; playerToken: string; wsUrl: string }>(`${BASE_URL}/v1/rooms`, {
    displayName: 'SmokeHost',
    maxPlayers: 2,
    rulesVariant: 'canonical',
  });
  const join = await postJson<{ roomCode: string; playerToken: string; wsUrl: string }>(
    `${BASE_URL}/v1/rooms/${create.roomCode}/join`,
    { displayName: 'SmokeGuest' },
  );

  const host = new Client(`${create.wsUrl}?token=${encodeURIComponent(create.playerToken)}`, 'host');
  const guest = new Client(`${join.wsUrl}?token=${encodeURIComponent(join.playerToken)}`, 'guest');
  await host.connect();
  await guest.connect();

  await host.send('room.ready', { ready: true });
  await guest.send('room.ready', { ready: true });
  await host.send('room.start', {});

  const hostSeat = await (async () => {
    const start = Date.now();
    while (host.latestSnapshot?.private?.seatIndex === undefined || host.latestSnapshot?.private?.seatIndex === null) {
      if (Date.now() - start > 5000) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return host.latestSnapshot.private.seatIndex as number;
  })();

  const clientsBySeat: Record<number, Client> = {
    [host.latestSnapshot.private.seatIndex]: host,
    [guest.latestSnapshot.private.seatIndex]: guest,
  };

  for (let i = 0; i < TURNS; i += 1) {
    await playStep(clientsBySeat, hostSeat);
    await new Promise((r) => setTimeout(r, 20));
  }

  console.log(
    JSON.stringify(
      {
        roomCode: create.roomCode,
        status: host.latestSnapshot?.room?.status,
        phase: host.latestSnapshot?.room?.game?.phase ?? null,
        roundNumber: host.latestSnapshot?.room?.game?.roundNumber ?? null,
      },
      null,
      2,
    ),
  );

  host.close();
  guest.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
