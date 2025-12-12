import app from './app';
import { config } from './config';
import { initializeDatabase } from './database/init';

async function start() {
  try {
    // Initialize database
    await initializeDatabase();

    // Start server
    app.listen(config.server.port, () => {
      console.log(`🚀 Server is running on http://localhost:${config.server.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
