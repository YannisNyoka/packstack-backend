import { DateTime } from 'luxon';
import { AuditLog } from '../models/AuditLog.js';

const DEFAULT_RETENTION_MONTHS = 6;

/**
 * Writes an audit log entry. Call this explicitly from service-layer
 * functions around sensitive actions (appointment edit/cancel/reschedule,
 * payment status change, role change, tenant settings change, integration
 * credential rotation) and from the auth service for login success/failure.
 * Runs inside the current tenant context, so the entry is automatically
 * scoped to the right tenant via tenantScopePlugin.
 */
export async function logAudit({
  req,
  actorUserId = null,
  actorCustomerId = null,
  actorType = 'user',
  action,
  entityType,
  entityId = null,
  diff = null,
}) {
  await AuditLog.create({
    actorUserId,
    actorCustomerId,
    actorType,
    action,
    entityType,
    entityId,
    diff,
    ip: req?.ip || null,
  });
}

/**
 * Deletes AuditLog entries older than the retention window, across every
 * tenant in one pass. AuditLog is otherwise append-only by design (see
 * models/AuditLog.js - it disables deleteOne/deleteMany/etc as a guard
 * against any route ever quietly erasing history) - this is the one
 * deliberate, narrow exception, and it stays narrow by reaching past the
 * Mongoose model entirely via AuditLog.collection (the raw MongoDB driver
 * handle) rather than relaxing that guard for anyone else.
 *
 * Not tenant-scoped on purpose: retention is a platform-wide policy, not a
 * per-tenant setting, and going through the raw collection also means this
 * skips tenantScopePlugin's query hooks - exactly why nothing else should
 * ever follow this pattern. Meant to run monthly via a scheduled job (see
 * jobs/pruneAuditLogs.js) - a full before/after diff on nearly every action,
 * with no prior pruning, makes this by far the fastest-growing collection
 * in the database.
 */
export async function pruneOldAuditLogs({ retentionMonths = DEFAULT_RETENTION_MONTHS } = {}) {
  const cutoff = DateTime.now().minus({ months: retentionMonths }).toJSDate();
  const result = await AuditLog.collection.deleteMany({ createdAt: { $lt: cutoff } });
  return { deletedCount: result.deletedCount, cutoff };
}
