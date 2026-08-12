import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as appointmentService from '../services/appointmentService.js';
import paymentRoutes from './paymentRoutes.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());

const createAppointmentSchema = z.object({
  staffMemberId: z.string(),
  serviceIds: z.array(z.string()).min(1),
  startTime: z.string(), // ISO string
  customerId: z.string().optional(),
  customerDetails: z
    .object({
      phone: z.string().min(5),
      name: z.string().min(1),
      email: z.string().email().optional(),
    })
    .optional(),
  notes: z.string().max(5000).optional(),
});

const rescheduleSchema = z.object({ newStartTime: z.string() });
const cancelSchema = z.object({ reason: z.string().max(1000).optional() });
const statusSchema = z.object({ status: z.enum(['confirmed', 'completed', 'no_show']) });

router.get('/', async (req, res, next) => {
  try {
    const { from, to, staffMemberId, status } = req.query;
    res.json(await appointmentService.listAppointments({ from, to, staffMemberId, status }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await appointmentService.getAppointmentById(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Staff/owner creating a booking from the dashboard bypasses the same-day
// cutoff (enforceBookingRules: false) - that rule exists to stop customers
// self-booking too late, not to stop the business taking a walk-in/phone booking.
router.post('/', validate(createAppointmentSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.createAppointment({
      req,
      tenantId: req.tenant._id,
      actorUserId: req.auth.userId,
      enforceBookingRules: false,
      data: req.body,
    });
    res.status(201).json(appointment);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/reschedule', validate(rescheduleSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.rescheduleAppointment({
      req,
      tenantId: req.tenant._id,
      actorUserId: req.auth.userId,
      id: req.params.id,
      newStartTime: req.body.newStartTime,
      enforceBookingRules: false,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/cancel', validate(cancelSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.cancelAppointment({
      req,
      tenantId: req.tenant._id,
      actorUserId: req.auth.userId,
      id: req.params.id,
      reason: req.body.reason,
      enforceBookingRules: false,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', validate(statusSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.updateAppointmentStatus({
      req,
      actorUserId: req.auth.userId,
      id: req.params.id,
      status: req.body.status,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.use('/:appointmentId/payments', paymentRoutes);

export default router;
