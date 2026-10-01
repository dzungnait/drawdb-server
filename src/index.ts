import app from './app';
import { config } from './config';
import { closePool } from './db';
import { migrate } from './db/migrate';
import { purgeExpiredSessions } from './auth/session';
import { purgeTrash } from './services/diagram-service';

async function start() {
  if (config.database.url) {
    await migrate();
    // Housekeeping; cheap enough to run hourly on every instance
    setInterval(
      () =>
        Promise.all([purgeExpiredSessions(), purgeTrash()]).catch((e) => console.error('Cleanup failed:', e)),
      60 * 60 * 1000,
    ).unref();
  } else {
    console.warn('DATABASE_URL is not set: accounts and cloud features are disabled');
  }

  const server = app.listen(config.server.port, () => {
    console.log(`Server is running on http://localhost:${config.server.port}`);
  });

  const shutdown = () => {
    server.close(() => {
      closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
