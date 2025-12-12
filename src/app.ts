import express from 'express';
import cors from 'cors';
import { emailRouter } from './routes/email-route';
import { designRouter } from './routes/design-route';
import { config } from './config';

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(
  cors({
    origin: config.dev
      ? '*'
      : (origin, callback) => {
          if (origin && config.server.allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
  }),
);

app.get('/', (req, res) => {
  res.send('Hello');
});

app.use('/email', emailRouter);
app.use('/gists', designRouter);

export default app;
