import 'dotenv/config';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app';
import { config } from './config';
import { initializeDatabase } from './database/init';
import { registerSocketHandlers } from './collaboration/socket-handlers';
import { ClientToServerEvents, ServerToClientEvents } from './collaboration/types';

async function start() {
  try {
    console.log('🔧 Environment loaded');
    console.log('DATABASE_URL:', process.env.DATABASE_URL);
    console.log('Railway PORT:', process.env.PORT);

    await initializeDatabase();

    const envPort = process.env.PORT;
    const port: number = envPort
      ? parseInt(envPort, 10)
      : Number(config.server.port) || 8080;

    const httpServer = http.createServer(app);

    const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
      cors: {
        origin: config.dev ? '*' : config.server.allowedOrigins,
        credentials: true,
      },
      pingInterval: 25000,
      pingTimeout: 20000,
    });

    registerSocketHandlers(io);

    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Server is running on port ${port}`);
      console.log(`🔌 Socket.IO ready for collaboration`);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
