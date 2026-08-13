import * as Sentry from '@sentry/node';
import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';

async function main() {
  await connectDB();
  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`packstack-backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  Sentry.captureException(err);
  process.exit(1);
});
