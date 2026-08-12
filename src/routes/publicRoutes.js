import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { rateLimitPublicByIp, rateLimitBookingByTenant } from '../middleware/rateLimit.js';
import * as serviceCatalogService from '../services/serviceCatalogService.js';
import * as staffService from '../services/staffService.js';
import * as appointmentService from '../services/appointmentService.js';
import * as depositService from '../services/depositService.js';
import { ThemeConfig } from '../models/ThemeConfig.js';
import { ApiError } from '../lib/ApiError.js';

// No requireAuth() here - this is the customer-facing booking surface.
// Still fully tenant-scoped (tenantResolution() already ran before this
// router is reached) and rate-limited, since it's the most exposed part of
// the API.
const router = Router({ mergeParams: true });

router.use(rateLimitPublicByIp);

router.get('/theme', async (req, res, next) => {
  try {
    const theme = await ThemeConfig.findOne({});
    if (!theme) throw ApiError.notFound('Not configured');
    res.json(theme);
  } catch (err) {
    next(err);
  }
});

router.get('/services', async (req, res, next) => {
  try {
    res.json(await serviceCatalogService.listServices({ includeInactive: false }));
  } catch (err) {
    next(err);
  }
});

router.get('/staff', async (req, res, next) => {
  try {
    res.json(await staffService.listStaff({ includeInactive: false }));
  } catch (err) {
    next(err);
  }
});

const availabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  serviceIds: z
    .string()
    .min(1)
    .transform((val) => val.split(',').map((id) => id.trim()).filter(Boolean)),
  staffMemberId: z.string().optional(),
});

router.get('/availability', validate(availabilityQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { date, serviceIds, staffMemberId } = req.query;
    const availability = await appointmentService.getAvailability({
      tenantId: req.tenant._id,
      date,
      serviceIds,
      staffMemberId,
    });
    res.json(availability);
  } catch (err) {
    next(err);
  }
});

const publicBookingSchema = z.object({
  staffMemberId: z.string(),
  serviceIds: z.array(z.string()).min(1),
  startTime: z.string(),
  customerDetails: z.object({
    phone: z.string().min(5),
    name: z.string().min(1),
    email: z.string().email().optional(),
  }),
  notes: z.string().max(1000).optional(),
});

router.post('/appointments', rateLimitBookingByTenant, validate(publicBookingSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.createAppointment({
      req,
      tenantId: req.tenant._id,
      actorUserId: null,
      enforceBookingRules: true,
      data: req.body,
    });
    res.status(201).json(appointment);
  } catch (err) {
    next(err);
  }
});

// Whether this tenant actually requires a deposit right now (both the
// bookingRules toggle AND a connected Yoco credential) - the booking
// frontend uses this to decide whether to route through /appointments
// (above, books immediately) or /appointments/checkout (below, holds the
// slot and sends the customer to pay first).
router.get('/deposit-config', async (req, res, next) => {
  try {
    res.json(await depositService.getDepositConfig(req.tenant._id));
  } catch (err) {
    next(err);
  }
});

router.post('/appointments/checkout', rateLimitBookingByTenant, validate(publicBookingSchema), async (req, res, next) => {
  try {
    const result = await depositService.createDepositCheckout({
      req,
      tenantId: req.tenant._id,
      tenantSlug: req.params.tenantSlug,
      data: req.body,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Yoco posts here directly, no session/JWT of any kind - same reasoning as
// PayFast's ITN route. req.rawBody is captured by app.js's express.json()
// verify hook and is what the HMAC signature in the webhook-signature header
// is actually computed over.
router.post('/deposit-webhook', async (req, res, next) => {
  try {
    await depositService.handleYocoWebhook({ headers: req.headers, rawBody: req.rawBody });
    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});

// Customer self-service via the signed link sent in the booking confirmation
// (see notificationService.sendBookingConfirmation) - no login, no auth
// middleware. The token itself is the credential: it identifies exactly one
// appointment and is rejected if it wasn't issued for this tenant (see
// appointmentService.getAppointmentByManageToken).
const manageTokenQuerySchema = z.object({ token: z.string().min(1) });

router.get('/appointments/manage', validate(manageTokenQuerySchema, 'query'), async (req, res, next) => {
  try {
    const appointment = await appointmentService.getAppointmentByManageToken({
      tenantId: req.tenant._id,
      token: req.query.token,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

const manageRescheduleSchema = z.object({ token: z.string().min(1), newStartTime: z.string() });

router.patch('/appointments/manage/reschedule', validate(manageRescheduleSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.rescheduleAppointmentByManageToken({
      req,
      tenantId: req.tenant._id,
      token: req.body.token,
      newStartTime: req.body.newStartTime,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

const manageCancelSchema = z.object({ token: z.string().min(1), reason: z.string().max(1000).optional() });

router.patch('/appointments/manage/cancel', validate(manageCancelSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.cancelAppointmentByManageToken({
      req,
      tenantId: req.tenant._id,
      token: req.body.token,
      reason: req.body.reason,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

export default router;
