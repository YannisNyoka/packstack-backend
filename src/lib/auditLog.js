import { AuditLog } from '../models/AuditLog.js';

/**
 * Writes an audit log entry. Call this explicitly from service-layer
 * functions around sensitive actions (appointment edit/cancel/reschedule,
 * payment status change, role change, tenant settings change, integration
 * credential rotation) and from the auth service for login success/failure.
 * Runs inside the current tenant context, so the entry is automatically
 * scoped to the right tenant via tenantScopePlugin.
 */
export async function logAudit({ req, actorUserId = null, actorType = 'user', action, entityType, entityId = null, diff = null }) {
  await AuditLog.create({
    actorUserId,
    actorType,
    action,
    entityType,
    entityId,
    diff,
    ip: req?.ip || null,
  });
}
