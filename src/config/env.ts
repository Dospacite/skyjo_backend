import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1).default('postgres://skyjo:skyjo@localhost:5432/skyjo'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ROOM_IDLE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  RECONNECT_GRACE_SECONDS: z.coerce.number().int().positive().default(120),
  WS_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
  WS_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(16_384),
  WS_MESSAGES_PER_SECOND: z.coerce.number().int().positive().default(40),
  WS_CONNECTION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  ACTION_REQUEST_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  CREATE_JOIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  ROOM_LOOKUP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  METRICS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  GAME_END_SCORE: z.coerce.number().int().positive().default(100),
  TOKEN_SECRET: z.string().min(8).default('change-me-please'),
  DEBUG_LOG_HIDDEN_CARDS: z.coerce.boolean().default(false),
  ENABLE_DB: z.coerce.boolean().default(true),
  RNG_SEED: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  return EnvSchema.parse(process.env);
}
