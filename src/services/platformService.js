import { DateTime } from 'luxon';
import { Tenant } from '../models/Tenant.js';
import { User } from '../models/User.js';
import { ThemeConfig } from '../models/ThemeConfig.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { hashPassword } from './authService.js';
import { ApiError } from '../lib/ApiError.js';

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
