import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { rateLimitAuthByIp } from '../middleware/rateLimit.js';
import * as platformService from '../services/platformService.js';
import { Plan } from '../models/Plan.js';
import { User } from '../models/User.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { signTenantAccessToken } from '../lib/jwt.js';
import { ApiError } from '../lib/ApiError.js';

// Unauthenticated, not tenant-resolved - mirrors publicPlansRoutes.js. This is
// the one place a member of the public can create a tenant; every other
// tenant-creation path (POST /api/platform/tenants) requires a superadmin.
// Reuses rateLimitAuthByIp (not the looser public limiter) since this creates
// accounts, not just reads data - same sensitivity as login.
const router = Router();

router.use(rateLimitAuthByIp);

const signupSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Must be a valid subdomain label'),
  displayName: z.string().trim().min(1).max(200),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(12, 'Password must be at least 12 characters'),
  planId: z.string(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
});

router.post('/', validate(signupSchema), async (req, res, next) => {
  try {
    const plan = await Plan.findOne({ _id: req.body.planId, active: true });
    if (!plan) throw ApiError.badRequest('Selected plan is not available');

    const tenant = await platformService.provisionTenant(req.body);

    // provisionTenant only returns the Tenant doc - reload the owner it just
    // created so we can mint them a session immediately (the whole point of
    // self-serve signup is landing the visitor straight into a usable
    // account, not bouncing them to a login page they've never seen before).
    const owner = await runWithTenant(tenant._id, async () => User.findOne({ role: 'owner' }));
    const accessToken = signTenantAccessToken({
      userId: owner._id,
      tenantId: tenant._id,
      role: owner.role,
      tokenVersion: owner.tokenVersion,
    });

    res.status(201).json({
      tenant: { slug: tenant.slug, displayName: tenant.displayName, trialEndsAt: tenant.trialEndsAt },
      accessToken,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
