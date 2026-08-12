import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { sendDueReminders } from '../services/reminderService.js';

// Meant to run roughly hourly via a Render Cron Job - see the docstring on
// sendDueReminders in services/reminderService.js for why the window is wide
// enough that an occasional missed run doesn't skip anyone's reminder.
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const { checkedTenants, sentCount } = await sendDueReminders();
  console.log(`[sendAppointmentReminders] checked ${checkedTenants} tenant(s), sent ${sentCount} reminder(s)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
