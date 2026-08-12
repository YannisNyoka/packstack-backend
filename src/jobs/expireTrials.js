import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { expireTrials } from '../services/billingService.js';

// Meant to run daily via a Render Cron Job, alongside the past-due sweep -
// see the docstring on expireTrials in services/billingService.js.
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const { checked, suspendedCount } = await expireTrials();
  console.log(`[expireTrials] checked ${checked} trial tenant(s) past their end date, suspended ${suspendedCount}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
