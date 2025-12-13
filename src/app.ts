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

export default app;
