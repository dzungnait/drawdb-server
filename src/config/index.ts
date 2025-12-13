import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const clientUrls = process.env.CLIENT_URLS ?? 'http://localhost:5173,http://localhost:5174,https://drawdb-production-e96b.up.railway.app';

export const config = {
  dev: process.env.NODE_ENV === 'dev',
  server: {
    port: process.env.PORT || 5000,
    allowedOrigins: clientUrls.split(','),
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/drawdb',
  },
  mail: {
    service: process.env.MAIL_SERVICE || 'gmail',
    username: process.env.MAIL_USERNAME || '',
    password: process.env.MAIL_PASSWORD || '',
  },
};
