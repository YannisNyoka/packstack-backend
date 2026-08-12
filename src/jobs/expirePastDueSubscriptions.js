import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { expirePastDueSubscriptions } from '../services/billingService.js';

// Meant to run via an external scheduler (a Render Cron Job on a daily
// schedule), not an in-process timer - see the docstring on
// expirePastDueSubscriptions in services/billingService.js for why.
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const { checked, suspendedCount } = await expirePastDueSubscriptions();
  console.log(`[expirePastDueSubscriptions] checked ${checked} tenant(s), suspended ${suspendedCount}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
