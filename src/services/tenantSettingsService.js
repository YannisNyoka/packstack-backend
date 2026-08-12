import { Tenant } from '../models/Tenant.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { clearTenantCache } from '../lib/tenantCache.js';

export async function getBookingRules(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('bookingRules').lean();
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return tenant.bookingRules;
}

export async function updateBookingRules({ req, actorUserId, tenantId, data }) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const before = tenant.bookingRules.toObject();
  Object.assign(tenant.bookingRules, data);
  await tenant.save();
  clearTenantCache(); // tenantResolution.js's slug cache holds a copy of this doc

  await logAudit({
    req,
    actorUserId,
    action: 'tenant.booking_rules_update',
    entityType: 'Tenant',
    entityId: tenantId,
    diff: { before, after: tenant.bookingRules.toObject() },
  });

  return tenant.bookingRules;
}
