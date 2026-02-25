import { buildApp } from './app';

async function main() {
  const ctx = await buildApp();
  try {
    await ctx.app.listen({ host: ctx.config.HOST, port: ctx.config.PORT });
    console.log(`listening on ${ctx.config.HOST}:${ctx.config.PORT}`);
  } catch (error) {
    await ctx.close();
    throw error;
  }

  const shutdown = async () => {
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
