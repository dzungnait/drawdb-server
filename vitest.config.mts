import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share one database
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://drawdb:drawdb@localhost:55432/drawdb_test',
      CLIENT_URLS: 'http://app.test',
      APP_URL: 'http://app.test',
      PUBLIC_API_URL: 'http://api.test',
      COOKIE_SECURE: 'false',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
    },
    globalSetup: ['test/global-setup.ts'],
  },
});
