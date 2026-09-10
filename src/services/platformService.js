import { DateTime } from 'luxon';
import { Tenant } from '../models/Tenant.js';
import { User } from '../models/User.js';
import { ThemeConfig } from '../models/ThemeConfig.js';
import { Subscription } from '../models/Subscription.js';
import { StaffMember } from '../models/StaffMember.js';
import { StaffTimeOff } from '../models/StaffTimeOff.js';
import { Customer } from '../models/Customer.js';
import { Service } from '../models/Service.js';
import { Appointment } from '../models/Appointment.js';
import { Payment } from '../models/Payment.js';
import { LoyaltyTransaction } from '../models/LoyaltyTransaction.js';
import { IntegrationCredential } from '../models/IntegrationCredential.js';
import { DomainMapping } from '../models/DomainMapping.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { clearTenantCache } from '../lib/tenantCache.js';
import { logAudit } from '../lib/auditLog.js';
import { hashPassword } from './authService.js';
import { removeDomainFromVercelProject } from '../lib/providers/vercelClient.js';
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

  const { subscription, owner } = await runWithTenant(tenant._id, async () => ({
    subscription: await Subscription.findOne({}).populate('planId'),
    owner: await User.findOne({ role: 'owner' }).select('email').sort({ createdAt: 1 }),
  }));

  return { tenant, subscription, owner };
}

/**
 * Business name is the one Tenant field a superadmin can fix up after the
 * fact (e.g. a typo at signup) - slug is immutable (Tenant.js), it's baked
 * into the subdomain and any links already sent to customers.
 */
export async function updateTenantProfile({ tenantId, displayName }) {
  const tenant = await Tenant.findByIdAndUpdate(tenantId, { displayName }, { new: true, runValidators: true });
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return tenant;
}

/**
 * Changes the tenant's owner login email - e.g. the owner lost access to
 * their original inbox and can't reset their own password without it. Only
 * ever touches the *oldest* 'owner' User, matching provisionTenant() which
 * creates exactly one; if a tenant somehow has more, this deliberately
 * leaves the rest alone rather than guessing which one the superadmin meant.
 */
export async function updateTenantOwnerEmail({ tenantId, email }) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const owner = await runWithTenant(tenant._id, async () => {
    const owner = await User.findOne({ role: 'owner' }).sort({ createdAt: 1 });
    if (!owner) throw ApiError.notFound('This tenant has no owner account');

    owner.email = email.toLowerCase();
    await owner.save();
    return owner;
  });

  return { id: owner._id, email: owner.email };
}

// Every tenant-scoped model except AuditLog - audit entries are append-only
// (see models/AuditLog.js's own guard) and deliberately outlive the tenant
// they describe, the same way deleting a person doesn't erase the news
// coverage of it. DomainMapping isn't tenant-scoped (models/DomainMapping.js)
// so it's cleaned up separately, by explicit tenantId filter, below.
const TENANT_SCOPED_MODELS = [
  Subscription,
  ThemeConfig,
  StaffMember,
  StaffTimeOff,
  Customer,
  Service,
  Appointment,
  Payment,
  LoyaltyTransaction,
  IntegrationCredential,
  User,
];

/**
 * Permanently deletes a tenant and everything belonging to it. Irreversible -
 * the frontend requires typing the tenant's slug back to confirm before
 * calling this. Logs the deletion into the tenant's own (surviving)
 * AuditLog before removing the Tenant document itself, so there's a
 * permanent record of when/why a now-nonexistent tenant was removed.
 */
export async function deprovisionTenant({ tenantId, req }) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const domains = await DomainMapping.find({ tenantId: tenant._id });
  for (const mapping of domains) {
    try {
      await removeDomainFromVercelProject(mapping.domain);
    } catch (err) {
      console.error(`[platformService] Vercel domain removal failed for ${mapping.domain}: ${err.message}`);
    }
  }
  await DomainMapping.deleteMany({ tenantId: tenant._id });

  await runWithTenant(tenant._id, async () => {
    for (const Model of TENANT_SCOPED_MODELS) {
      await Model.deleteMany({});
    }

    await logAudit({
      req,
      actorType: 'superadmin',
      action: 'platform.tenant_deleted',
      entityType: 'Tenant',
      entityId: tenant._id,
      diff: { before: { slug: tenant.slug, displayName: tenant.displayName, status: tenant.status } },
    });
  });

  await Tenant.findByIdAndDelete(tenant._id);
  clearTenantCache();
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
