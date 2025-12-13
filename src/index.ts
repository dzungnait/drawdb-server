import 'dotenv/config';
import app from './app';
import { config } from './config';
import { initializeDatabase } from './database/init';

async function start() {
  try {
    console.log('🔧 Environment loaded');
    console.log('DATABASE_URL:', process.env.DATABASE_URL);

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
