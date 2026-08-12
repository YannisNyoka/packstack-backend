import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { releaseStalePendingPayments } from '../services/depositService.js';

// Meant to run frequently (e.g. every 5-10 minutes via a Render Cron Job) -
// see the docstring on releaseStalePendingPayments in services/depositService.js.
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const { checkedTenants, releasedCount } = await releaseStalePendingPayments();
  console.log(`[expireStalePendingPayments] checked ${checkedTenants} tenant(s), released ${releasedCount} stale slot(s)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
