import { Pool } from 'pg';
import type { AppConfig } from '../config/env';
import { NoopStorage } from './noop';
import { PgStorage } from './pg';
import type { StorageAdapter } from './types';

export function createStorage(config: AppConfig): StorageAdapter {
  if (!config.ENABLE_DB) {
    return new NoopStorage();
  }
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  return new PgStorage(pool);
}
