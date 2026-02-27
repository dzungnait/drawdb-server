import 'dotenv/config';
import app from './app';
import { config } from './config';
import { initializeDatabase } from './database/init';

async function start() {
  try {
    console.log('🔧 Environment loaded');
    console.log('DATABASE_URL:', process.env.DATABASE_URL);
    console.log('Railway PORT:', process.env.PORT);

    await initializeDatabase();

    const port = process.env.PORT || config.server.port || 8080;

    app.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Server is running on port ${port}`);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
