import { loadConfig } from '../config/env';
import { createStorage } from './factory';

async function main() {
  const config = loadConfig();
  const storage = createStorage(config);
  try {
    await storage.migrate();
    console.log('migrations applied');
  } finally {
    await storage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
