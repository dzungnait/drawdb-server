import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { emailRouter } from './routes/email-route';
import { gistRouter } from './routes/gist-route';
import { authRouter } from './routes/auth-route';
import { diagramRouter } from './routes/diagram-route';
import { config } from './config';
import { checkOrigin, loadUser } from './auth/middleware';
import { apiLimiter } from './middleware/rate-limit';
import { errorHandler, notFoundHandler } from './middleware/error-handler';

const app = express();

app.set('trust proxy', config.server.trustProxy);
app.disable('x-powered-by');

app.use(helmet());
app.use(
  cors({
    // Cookies need a concrete origin, never "*"
    origin: config.dev
      ? true
      : (origin, callback) => {
          callback(null, Boolean(origin && config.server.allowedOrigins.includes(origin)));
        },
    credentials: true,
  }),
);
app.use(express.json({ limit: config.limits.bodySize }));
app.use(cookieParser());
app.use(apiLimiter);

app.get('/', (req, res) => {
  res.send('Hello');
});
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/email', emailRouter);
app.use('/gists', gistRouter);

const databaseConfigured = Boolean(config.database.url);
if (databaseConfigured) {
  app.use(checkOrigin, loadUser);
  app.use('/auth', authRouter);
  app.use('/diagrams', diagramRouter);
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
