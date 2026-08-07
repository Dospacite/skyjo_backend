import { URL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import { loadConfig } from '../config/env';
import { createStorage } from '../storage/factory';
import type { StorageAdapter } from '../storage/types';
import { toApiError, AppError } from '../types/errors';
import { createLogger } from './logger';
import { createMetrics } from './metrics';
import { RoomManager } from './room-manager';
import { CreateRoomBodySchema, JoinRoomBodySchema } from './schemas';

export interface AppContext {
  app: FastifyInstance;
  wsServer: WebSocketServer;
  roomManager: RoomManager;
  config: AppConfig;
  storage: StorageAdapter;
  metrics: ReturnType<typeof createMetrics>;
  close(): Promise<void>;
}

interface InMemoryRateLimiter {
  consume(key: string): boolean;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.flatten());
  }
  return parsed.data;
}

function buildWsUrl(req: Parameters<FastifyInstance['get']>[1] extends never ? never : any): string {
  const proto = req.protocol === 'https' ? 'wss' : 'ws';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `${req.hostname}`;
  return `${proto}://${host}/v1/ws`;
}

function createInMemoryRateLimiter({ max, windowMs }: { max: number; windowMs: number }): InMemoryRateLimiter {
  const buckets = new Map<string, { startedAt: number; count: number }>();

  return {
    consume(key: string): boolean {
      const now = Date.now();
      const existing = buckets.get(key);
      if (!existing || now - existing.startedAt >= windowMs) {
        buckets.set(key, { startedAt: now, count: 1 });
        return true;
      }
      if (existing.count >= max) {
        return false;
      }
      existing.count += 1;
      return true;
    },
  };
}

function requestClientKey(req: { ip?: string; headers: Record<string, unknown> }): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0]!.trim();
  }
  return req.ip ?? 'unknown';
}

export async function buildApp(overrides?: { config?: AppConfig; storage?: StorageAdapter }): Promise<AppContext> {
  const config = overrides?.config ?? loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const app = Fastify({ logger: false, disableRequestLogging: true });
  const metrics = createMetrics();
  const storage = overrides?.storage ?? createStorage(config);
  const wsConnectionLimiter = createInMemoryRateLimiter({
    max: config.WS_CONNECTION_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });
  await storage.migrate();

  const roomManager = new RoomManager(config, storage, logger, metrics);
  roomManager.startBackgroundTasks();

  await app.register(rateLimit, {
    global: false,
  });
  await app.register(cors, {
    origin: true,
    credentials: false,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send(toApiError(err));
      return;
    }
    if (err instanceof z.ZodError) {
      reply.status(400).send(toApiError(new AppError('VALIDATION_ERROR', 'Invalid request', 400, err.flatten())));
      return;
    }
    if (typeof (err as { statusCode?: unknown }).statusCode === 'number') {
      const statusCode = (err as { statusCode: number }).statusCode;
      const message = err.message || 'Request failed';
      const code = statusCode === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
      reply.status(statusCode).send(toApiError(new AppError(code, message, statusCode)));
      return;
    }
    logger.error({ err }, 'http request failed');
    reply.status(500).send(toApiError(err));
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true }));
  app.get(
    '/metrics',
    {
      config: {
        rateLimit: { max: config.METRICS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
      },
    },
    async () => ({ ...metrics }),
  );

  app.post(
    '/v1/rooms',
    {
      config: {
        rateLimit: { max: config.CREATE_JOIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = parseBody(CreateRoomBodySchema, req.body);
      const { roomCode, playerToken } = await roomManager.createRoom(body);
      reply.status(201).send({ roomCode, playerToken, wsUrl: buildWsUrl(req) });
    },
  );

  app.post(
    '/v1/rooms/:code/join',
    {
      config: {
        rateLimit: { max: config.CREATE_JOIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = parseBody(JoinRoomBodySchema, req.body);
      const code = String((req.params as Record<string, string>).code ?? '');
      const { roomCode, playerToken } = await roomManager.joinRoom({ roomCode: code, displayName: body.displayName });
      reply.status(200).send({ roomCode, playerToken, wsUrl: buildWsUrl(req) });
    },
  );

  app.get(
    '/v1/rooms/:code',
    {
      config: {
        rateLimit: { max: config.ROOM_LOOKUP_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
      },
    },
    async (req) => {
      const code = String((req.params as Record<string, string>).code ?? '');
      return roomManager.getRoomPublicState(code);
    },
  );

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: config.WS_MAX_MESSAGE_BYTES });

  wsServer.on('connection', (ws, request) => {
    const conn = roomManager.createUnauthedConnection(ws);
    const reqUrl = new URL(request.url ?? '/v1/ws', `http://${request.headers.host ?? 'localhost'}`);
    const queryToken = reqUrl.searchParams.get('token');
    if (queryToken) {
      roomManager.tryAuthenticateConnection(conn, queryToken).catch((_error) => {
        try {
          ws.close(4401, 'Unauthorized');
        } catch {
          // ignore
        }
      });
    }

    ws.on('message', (msg) => {
      void roomManager.handleRawMessage(conn, msg);
    });
    ws.on('pong', () => roomManager.onPong(conn));
    ws.on('close', () => roomManager.onSocketClose(conn));
    ws.on('error', () => roomManager.onSocketClose(conn));
  });

  app.server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/v1/ws') {
        socket.destroy();
        return;
      }
      const clientKey = requestClientKey({ ip: request.socket.remoteAddress ?? undefined, headers: request.headers });
      if (!wsConnectionLimiter.consume(clientKey)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit('connection', ws, request);
      });
    } catch {
      socket.destroy();
    }
  });

  return {
    app,
    wsServer,
    roomManager,
    config,
    storage,
    metrics,
    async close() {
      await roomManager.shutdown();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await app.close();
      await storage.close();
    },
  };
}
