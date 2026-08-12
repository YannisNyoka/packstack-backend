import { Router } from 'express';
import { rateLimitPublicByIp } from '../middleware/rateLimit.js';
import { Plan } from '../models/Plan.js';

// Unauthenticated, not tenant-resolved - the marketing site (a separate,
// unauthenticated origin with no tenant context of its own) needs this to
// render real pricing instead of hardcoded copy. Same reasoning as
// publicDomainRoutes.js: mounted directly under /api/public, ahead of any
// tenant/auth middleware.
const router = Router();

router.use(rateLimitPublicByIp);

router.get('/', async (req, res, next) => {
  try {
    const plans = await Plan.find({ active: true }).select('key name priceZAR billingInterval limits').sort({ priceZAR: 1 });
    res.json(plans);
  } catch (err) {
    next(err);
  }
});

export default router;
