import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import * as loyaltyService from '../services/loyaltyService.js';

// Auth is already applied by the parent customerRoutes router.
const router = Router({ mergeParams: true });

const redeemSchema = z.object({
  points: z.number().int().positive(),
  relatedAppointmentId: z.string().optional(),
});

const adjustSchema = z.object({
  pointsDelta: z.number().int(),
  reasonNote: z.string().max(500).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await loyaltyService.getLoyaltyHistory(req.params.customerId));
  } catch (err) {
    next(err);
  }
});

router.post('/redeem', validate(redeemSchema), async (req, res, next) => {
  try {
    const customer = await loyaltyService.redeemPoints({
      req,
      actorUserId: req.auth.userId,
      customerId: req.params.customerId,
      points: req.body.points,
      relatedAppointmentId: req.body.relatedAppointmentId,
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

router.post('/adjust', requireRole('owner'), validate(adjustSchema), async (req, res, next) => {
  try {
    const customer = await loyaltyService.adjustPoints({
      req,
      actorUserId: req.auth.userId,
      customerId: req.params.customerId,
      pointsDelta: req.body.pointsDelta,
      reasonNote: req.body.reasonNote,
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

export default router;
