import { createServer } from 'http';
import app from './app';
import { attachCollab } from './collab/socket';
import { flushAllRooms } from './collab/rooms';
import { config } from './config';
import { closePool } from './db';
import { migrate } from './db/migrate';
import { purgeExpiredSessions } from './auth/session';
import { purgeTrash } from './services/diagram-service';
import { purgeVersions } from './services/snapshots';
import { purgeExpiredLinks } from './services/link-service';

async function start() {
  if (config.database.url) {
    await migrate();
    // Housekeeping; cheap enough to run hourly on every instance
    setInterval(
      () =>
        Promise.all([
          purgeExpiredSessions(),
          purgeTrash(),
          purgeVersions(),
          purgeExpiredLinks(),
        ]).catch((e) => console.error('Cleanup failed:', e)),
      60 * 60 * 1000,
    ).unref();
  } else {
    console.warn('DATABASE_URL is not set: accounts and cloud features are disabled');
  }

  const server = createServer(app);
  // Live collaboration needs the database (rooms load and save diagrams)
  const io = config.database.url ? attachCollab(server) : null;
  server.listen(config.server.port, () => {
    console.log(`Server is running on http://localhost:${config.server.port}`);
  });

  const shutdown = async () => {
    io?.close();
    // Edits still waiting in open rooms
    await flushAllRooms();
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
