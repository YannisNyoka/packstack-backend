import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import * as platformService from '../services/platformService.js';
import platformAuthRoutes from './platformAuthRoutes.js';
import platformBillingRoutes from './platformBillingRoutes.js';
import { Plan } from '../models/Plan.js';

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

export default router;
