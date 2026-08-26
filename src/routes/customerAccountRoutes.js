import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireCustomerAuth } from '../middleware/auth.js';
import * as appointmentService from '../services/appointmentService.js';
import * as depositService from '../services/depositService.js';
import { getLoyaltyHistory } from '../services/loyaltyService.js';
import { changeCustomerPassword, updateOwnProfile, toPublicCustomer } from '../services/customerAuthService.js';
import { Customer } from '../models/Customer.js';
import { ApiError } from '../lib/ApiError.js';

// Self-service surface for a logged-in customer account - view/manage their
// OWN appointments and loyalty points. Distinct from customerRoutes.js,
// which is the staff/owner-facing CRUD over every customer and requires
// requireAuth() (staff login), not this router's requireCustomerAuth().
const router = Router({ mergeParams: true });
router.use(requireCustomerAuth());

const FINAL_STATUSES = ['cancelled', 'completed', 'no_show'];

/**
 * appointmentService.getAppointmentById/listAppointments populate customerId,
 * so it may be an object or a bare ObjectId depending on the call - handle
 * both. Mirrors the "does this token/link belong to this tenant" checks
 * elsewhere (requireAuth, verifyManageToken), just for account ownership.
 */
function assertOwnsAppointment(appointment, req) {
  const ownerId = String(appointment.customerId?._id ?? appointment.customerId);
  if (ownerId !== req.customerAuth.customerId) {
    throw ApiError.forbidden('This appointment does not belong to your account');
  }
}

const createAppointmentSchema = z.object({
  staffMemberId: z.string(),
  serviceIds: z.array(z.string()).min(1),
  startTime: z.string(),
  notes: z.string().max(1000).optional(),
});

// The authenticated counterpart to publicRoutes.js's POST /appointments -
// identity comes from the verified customer token (customerId), never from
// a form field, unlike the anonymous flow's customerDetails. This is the
// only booking path once a tenant turns off anonymous booking
// (Tenant.bookingRules.requireCustomerAccount), but it works for any
// logged-in customer regardless of that setting.
router.post('/appointments', validate(createAppointmentSchema), async (req, res, next) => {
  try {
    const appointment = await appointmentService.createAppointment({
      req,
      tenantId: req.tenant._id,
      actorUserId: null,
      enforceBookingRules: true,
      data: { ...req.body, customerId: req.customerAuth.customerId },
    });
    res.status(201).json(appointment);
  } catch (err) {
    next(err);
  }
});

router.post('/appointments/checkout', validate(createAppointmentSchema), async (req, res, next) => {
  try {
    const result = await depositService.createDepositCheckout({
      req,
      tenantId: req.tenant._id,
      tenantSlug: req.params.tenantSlug,
      data: { ...req.body, customerId: req.customerAuth.customerId },
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/appointments', async (req, res, next) => {
  try {
    const wantHistory = req.query.status === 'history';
    const appointments = await appointmentService.listAppointments({ customerId: req.customerAuth.customerId });
    const now = new Date();
    const filtered = appointments.filter((apt) => {
      const isFinalOrPast = FINAL_STATUSES.includes(apt.status) || apt.startTime < now;
      return wantHistory ? isFinalOrPast : !isFinalOrPast;
    });
    if (wantHistory) filtered.reverse(); // most recent first for history
    res.json(filtered);
  } catch (err) {
    next(err);
  }
});

router.get('/appointments/:id', async (req, res, next) => {
  try {
    const appointment = await appointmentService.getAppointmentById(req.params.id);
    assertOwnsAppointment(appointment, req);
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

const rescheduleSchema = z.object({ newStartTime: z.string() });

router.patch('/appointments/:id/reschedule', validate(rescheduleSchema), async (req, res, next) => {
  try {
    const existing = await appointmentService.getAppointmentById(req.params.id);
    assertOwnsAppointment(existing, req);

    const appointment = await appointmentService.rescheduleAppointment({
      req,
      tenantId: req.tenant._id,
      actorType: 'customer',
      actorCustomerId: req.customerAuth.customerId,
      id: req.params.id,
      newStartTime: req.body.newStartTime,
      enforceBookingRules: true,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

const cancelSchema = z.object({ reason: z.string().max(1000).optional() });

router.patch('/appointments/:id/cancel', validate(cancelSchema), async (req, res, next) => {
  try {
    const existing = await appointmentService.getAppointmentById(req.params.id);
    assertOwnsAppointment(existing, req);

    const appointment = await appointmentService.cancelAppointment({
      req,
      tenantId: req.tenant._id,
      actorType: 'customer',
      actorCustomerId: req.customerAuth.customerId,
      id: req.params.id,
      reason: req.body.reason,
      enforceBookingRules: true,
    });
    res.json(appointment);
  } catch (err) {
    next(err);
  }
});

router.get('/loyalty', async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.customerAuth.customerId);
    if (!customer) throw ApiError.notFound('Account not found');
    const history = await getLoyaltyHistory(req.customerAuth.customerId);
    res.json({ balance: customer.loyaltyPoints, history });
  } catch (err) {
    next(err);
  }
});

router.get('/profile', async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.customerAuth.customerId);
    if (!customer) throw ApiError.notFound('Account not found');
    res.json(toPublicCustomer(customer));
  } catch (err) {
    next(err);
  }
});

const updateProfileSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // No longer clearable to '' - email is the account's login identifier now,
  // not an optional contact field.
  email: z.string().email().optional(),
});

router.patch('/profile', validate(updateProfileSchema), async (req, res, next) => {
  try {
    const customer = await updateOwnProfile({
      req,
      customerId: req.customerAuth.customerId,
      name: req.body.name,
      email: req.body.email,
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/password', validate(changePasswordSchema), async (req, res, next) => {
  try {
    await changeCustomerPassword({
      req,
      customerId: req.customerAuth.customerId,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
