import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function loadMigrationFiles(migrationsDir: string): Array<{ version: string; sql: string }> {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ version: file, sql: readFileSync(join(migrationsDir, file), 'utf8') }));
}
