import { DateTime } from 'luxon';
import { Tenant } from '../models/Tenant.js';
import { User } from '../models/User.js';
import { ThemeConfig } from '../models/ThemeConfig.js';
import { Subscription } from '../models/Subscription.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { clearTenantCache } from '../lib/tenantCache.js';
import { logAudit } from '../lib/auditLog.js';
import { hashPassword } from './authService.js';
import { ApiError } from '../lib/ApiError.js';

const TENANT_STATUSES = ['trial', 'active', 'past_due', 'suspended'];

// Every new tenant gets a month of full access before billingService's
// expireTrials() sweep suspends them if they haven't subscribed - see that
// function's own docstring for what "suspended" actually restricts.
export const TRIAL_LENGTH_DAYS = 30;

/**
 * Provisions a new tenant: the Tenant document itself (no tenant context
 * needed - it's not tenant-scoped), then everything that belongs to it
 * (owner User, default ThemeConfig) created inside runWithTenant() so they
 * pick up the right tenantId via tenantScopePlugin like any other write.
 */
export async function provisionTenant({ slug, displayName, ownerEmail, ownerPassword, timezone, currency }) {
  const existing = await Tenant.findOne({ slug: slug.toLowerCase() });
  if (existing) throw ApiError.conflict('That subdomain is already taken');

  const tenant = await Tenant.create({
    slug: slug.toLowerCase(),
    displayName,
    timezone: timezone || 'Africa/Johannesburg',
    currency: currency || 'ZAR',
    trialEndsAt: DateTime.now().plus({ days: TRIAL_LENGTH_DAYS }).toJSDate(),
  });

  await runWithTenant(tenant._id, async () => {
    const passwordHash = await hashPassword(ownerPassword);
    await User.create({ email: ownerEmail.toLowerCase(), passwordHash, role: 'owner' });
    await ThemeConfig.create({ businessName: displayName });
  });

  return tenant;
}

export async function listTenants() {
  return Tenant.find({}).sort({ createdAt: -1 });
}

/**
 * Tenant plus its billing Subscription (populated with the Plan it's on),
 * for the superadmin console's tenant detail view. Subscription is
 * tenant-scoped (tenantScopePlugin), so it can only be read from inside
 * runWithTenant() - see lib/tenantContext.js.
 */
export async function getTenantDetail(tenantId) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const subscription = await runWithTenant(tenant._id, () => Subscription.findOne({}).populate('planId'));

  return { tenant, subscription };
}

/**
 * Manual override of Tenant.status from the superadmin console - the same
 * field billingService.js's cron sweeps (expireTrials, expirePastDueSubscriptions)
 * and the PayFast ITN handler transition automatically, exposed here for the
 * cases those can't cover: reactivating a tenant who paid outside PayFast,
 * suspending one manually for abuse/non-payment before the automated sweep
 * would, etc. See middleware/enforceTenantStatus.js for what each status
 * actually restricts.
 */
export async function updateTenantStatus({ tenantId, status, req }) {
  if (!TENANT_STATUSES.includes(status)) throw ApiError.badRequest('Invalid status');

  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const before = tenant.status;
  tenant.status = status;
  await tenant.save();
  clearTenantCache();

  // AuditLog is tenant-scoped (tenantScopePlugin) - the write needs a bound
  // tenant context even though the actor here is a superadmin, not a tenant
  // user. Same pattern as billingService.js's expireTrials/expirePastDueSubscriptions.
  // actorUserId is deliberately omitted - it's a SuperAdminUser id, not the
  // tenant-scoped User the field's ref points at (same convention as the
  // PayFast ITN handler's audit entries in billingService.js).
  await runWithTenant(tenant._id, () =>
    logAudit({
      req,
      actorType: 'superadmin',
      action: 'platform.tenant_status_changed',
      entityType: 'Tenant',
      entityId: tenant._id,
      diff: { before: { status: before }, after: { status } },
    })
  );

  return tenant;
}
