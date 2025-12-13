import express from 'express';
import cors from 'cors';
import { emailRouter } from './routes/email-route';
import { designRouter } from './routes/design-route';
import { config } from './config';

const app = express();

// Add request logging
app.use((req, res, next) => {
  console.log(`📨 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(
  cors({
    origin: config.dev
      ? '*' // Allow all origins in dev mode
      : (origin, callback) => {
          if (origin && config.server.allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
    credentials: true, // Allow credentials
  }),
);

app.get('/', (req, res) => {
  res.send('Hello');
});

app.use('/email', emailRouter);
app.use('/gists', designRouter);
app.use('/designs', designRouter); // Add this for compatibility

// Import lock controller
import {
  lock,
  unlock,
  heartbeat,
} from './controllers/lock-controller';

// Wrapper functions for direct lock endpoints
const lockWrapper = async (req: express.Request, res: express.Response) => {
  const designId = req.body.designId || req.body.gistId;
  if (!designId) {
    return res.status(400).json({ error: 'designId required' });
  }
  req.params.id = designId;
  await lock(req, res);
};

const unlockWrapper = async (req: express.Request, res: express.Response) => {
  const designId = req.body.designId || req.body.gistId;
  if (!designId) {
    return res.status(400).json({ error: 'designId required' });
  }
  req.params.id = designId;
  await unlock(req, res);
};

const heartbeatWrapper = async (req: express.Request, res: express.Response) => {
  const designId = req.body.designId || req.body.gistId;
  if (!designId) {
    return res.status(400).json({ error: 'designId required' });
  }
  req.params.id = designId;
  await heartbeat(req, res);
};

// Add direct lock endpoints for compatibility
app.post('/lock', lockWrapper as any);
app.delete('/unlock', unlockWrapper as any);
app.post('/heartbeat', heartbeatWrapper as any);

export default app;
