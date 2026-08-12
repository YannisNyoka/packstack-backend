import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import * as paymentService from '../services/paymentService.js';

// Auth (requireAuth) is already applied by the parent appointmentRoutes
// router before this is mounted - mergeParams gives access to :appointmentId.
const router = Router({ mergeParams: true });

const recordPaymentSchema = z.object({
  amount: z.number().min(0),
  method: z.enum(['cash', 'card', 'online']),
  provider: z.enum(['cash', 'yoco', 'manual']),
  providerTransactionId: z.string().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await paymentService.listPaymentsForAppointment(req.params.appointmentId));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(recordPaymentSchema), async (req, res, next) => {
  try {
    const result = await paymentService.recordPayment({
      req,
      actorUserId: req.auth.userId,
      appointmentId: req.params.appointmentId,
      ...req.body,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
