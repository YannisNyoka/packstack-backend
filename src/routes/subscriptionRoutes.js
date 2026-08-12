import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as billingService from '../services/billingService.js';
import { Plan } from '../models/Plan.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());
router.use(requireRole('owner'));

// Tenant-facing counterpart to the superadmin-only GET /api/platform/plans -
// an owner needs to see what they can subscribe to before POSTing /checkout,
// but has no superadmin session to call that route with.
router.get('/plans', async (req, res, next) => {
  try {
    res.json(await Plan.find({ active: true }).sort({ priceZAR: 1 }));
  } catch (err) {
    next(err);
  }
});

router.get('/subscription', async (req, res, next) => {
  try {
    res.json(await billingService.getSubscription());
  } catch (err) {
    next(err);
  }
});

const checkoutSchema = z.object({ planId: z.string() });

router.post('/checkout', validate(checkoutSchema), async (req, res, next) => {
  try {
    const checkout = await billingService.createCheckoutForPlan({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      tenantSlug: req.params.tenantSlug,
      planId: req.body.planId,
    });
    res.status(201).json(checkout);
  } catch (err) {
    next(err);
  }
});

router.post('/cancel', async (req, res, next) => {
  try {
    const subscription = await billingService.cancelSubscription({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
    });
    res.json(subscription);
  } catch (err) {
    next(err);
  }
});

export default router;
