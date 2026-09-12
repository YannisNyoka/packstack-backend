import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { pruneOldAuditLogs } from '../lib/auditLog.js';

// Meant to run monthly via a scheduled GitHub Actions workflow (see
// .github/workflows/cron-prune-audit-logs.yml) - see pruneOldAuditLogs'
// own docstring in lib/auditLog.js for why this is the one deliberate
// exception to AuditLog's append-only design.
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const { deletedCount, cutoff } = await pruneOldAuditLogs();
  console.log(`[pruneAuditLogs] deleted ${deletedCount} audit log entr${deletedCount === 1 ? 'y' : 'ies'} older than ${cutoff.toISOString()}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
