import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import * as platformService from '../services/platformService.js';
import platformAuthRoutes from './platformAuthRoutes.js';
import platformBillingRoutes from './platformBillingRoutes.js';
import { Plan } from '../models/Plan.js';
import { ApiError } from '../lib/ApiError.js';

// No tenantResolution() in front of this router at all - see app.js. This
// is deliberately the one part of the API that isn't tenant-scoped.
const router = Router();

// Mounted before the requireSuperAdmin() gate below - you can't authenticate
// if authenticating already requires being authenticated, and PayFast can't
// authenticate as a superadmin at all. Both apply their own auth (logout-all)
// or none (the PayFast ITN, which has no session/JWT to check) as needed.
router.use('/auth', platformAuthRoutes);
router.use('/billing', platformBillingRoutes);

router.use(requireSuperAdmin());

const provisionTenantSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Must be a valid subdomain label'),
  displayName: z.string().trim().min(1).max(200),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(12, 'Owner password must be at least 12 characters'),
  timezone: z.string().optional(),
  currency: z.string().optional(),
});

router.get('/tenants', async (req, res, next) => {
  try {
    res.json(await platformService.listTenants());
  } catch (err) {
    next(err);
  }
});

router.post('/tenants', validate(provisionTenantSchema), async (req, res, next) => {
  try {
    const tenant = await platformService.provisionTenant(req.body);
    res.status(201).json(tenant);
  } catch (err) {
    next(err);
  }
});

router.get('/tenants/:id', async (req, res, next) => {
  try {
    res.json(await platformService.getTenantDetail(req.params.id));
  } catch (err) {
    next(err);
  }
});

const tenantStatusSchema = z.object({
  status: z.enum(['trial', 'active', 'past_due', 'suspended']),
});

router.patch('/tenants/:id/status', validate(tenantStatusSchema), async (req, res, next) => {
  try {
    const tenant = await platformService.updateTenantStatus({
      tenantId: req.params.id,
      status: req.body.status,
      req,
    });
    res.json(tenant);
  } catch (err) {
    next(err);
  }
});

const tenantProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
});

router.patch('/tenants/:id', validate(tenantProfileSchema), async (req, res, next) => {
  try {
    const tenant = await platformService.updateTenantProfile({ tenantId: req.params.id, displayName: req.body.displayName });
    res.json(tenant);
  } catch (err) {
    next(err);
  }
});

const tenantOwnerSchema = z.object({
  email: z.string().trim().email(),
});

router.patch('/tenants/:id/owner', validate(tenantOwnerSchema), async (req, res, next) => {
  try {
    const owner = await platformService.updateTenantOwnerEmail({ tenantId: req.params.id, email: req.body.email });
    res.json(owner);
  } catch (err) {
    next(err);
  }
});

const tenantDeleteSchema = z.object({
  slug: z.string().trim().toLowerCase(),
});

// Requires the tenant's own slug back in the body as a deliberate typed
// confirmation (mirrors the frontend's "type the slug to confirm" prompt) -
// this is permanent, cascades across every tenant-scoped collection, and a
// bare DELETE with just the :id in the URL is too easy to fire accidentally
// (a stray retry, a copy-pasted curl command) for something this destructive.
router.delete('/tenants/:id', validate(tenantDeleteSchema), async (req, res, next) => {
  try {
    const tenant = await platformService.getTenantDetail(req.params.id);
    if (tenant.tenant.slug !== req.body.slug) {
      throw ApiError.badRequest('Slug confirmation does not match this tenant');
    }
    await platformService.deprovisionTenant({ tenantId: req.params.id, req });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const planSchema = z.object({
  key: z.string().trim().toLowerCase().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  priceZAR: z.number().min(0),
  billingInterval: z.enum(['monthly', 'annual']).default('monthly'),
  limits: z.object({
    maxStaff: z.number().int().min(1),
    maxAppointmentsPerMonth: z.number().int().min(1),
    whatsappMessagesPerMonth: z.number().int().min(0),
    customDomainAllowed: z.boolean().default(false),
  }),
});

// Plan is a small, mostly-static reference table (§3 of the architecture
// doc) - superadmin-managed, not tenant-scoped, not part of the PayFast
// wiring itself but load-bearing for it (a tenant subscribes *to* a Plan).
router.get('/plans', async (req, res, next) => {
  try {
    res.json(await Plan.find({}).sort({ priceZAR: 1 }));
  } catch (err) {
    next(err);
  }
});

router.post('/plans', validate(planSchema), async (req, res, next) => {
  try {
    res.status(201).json(await Plan.create(req.body));
  } catch (err) {
    next(err);
  }
});

const planUpdateSchema = planSchema.partial().extend({ active: z.boolean().optional() });

router.patch('/plans/:id', validate(planUpdateSchema), async (req, res, next) => {
  try {
    const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!plan) throw ApiError.notFound('Plan not found');
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

export default router;
