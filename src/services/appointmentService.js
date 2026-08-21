import { DateTime } from 'luxon';
import { Appointment } from '../models/Appointment.js';
import { Service } from '../models/Service.js';
import { StaffMember } from '../models/StaffMember.js';
import { Tenant } from '../models/Tenant.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { isSameDayCutoffPassed, isWithinChangeWindow } from '../lib/bookingRules.js';
import { findOrCreateByPhone, getCustomerById } from './customerService.js';
import { getTimeOffRangesByStaff } from './staffTimeOffService.js';
import { earnPointsForCompletedAppointment } from './loyaltyService.js';
import { sendBookingConfirmation } from './notificationService.js';
import { signAppointmentManageToken, verifyAppointmentManageToken } from '../lib/jwt.js';
import { env } from '../config/env.js';

// 'pending_payment' occupies a slot exactly like a real booking (a deposit
// checkout in flight must not be double-booked out from under the customer
// who's mid-payment), even though it isn't confirmed yet.
const OPEN_STATUSES = ['pending_payment', 'booked', 'confirmed'];
const FINAL_STATUSES = ['cancelled', 'completed', 'no_show'];

// Candidate slot start times are generated on this grid within each working-hours
// range - fine enough granularity for walk-in-style booking UIs without generating
// a slot per minute.
const SLOT_GRANULARITY_MINUTES = 15;

function timeStringToMinutes(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute;
}

// Points at packstack-frontend's /manage route (pages/ManagePage.jsx), which
// reads `?token=` and calls the public manage endpoints below. Exported so
// services/reminderService.js can build the same link for reminder messages.
export function buildManageUrl({ tenant, appointment }) {
  const token = signAppointmentManageToken({
    appointmentId: appointment._id,
    tenantId: tenant._id,
    expiresAt: appointment.startTime,
  });
  return `https://${tenant.slug}.${env.BASE_DOMAIN}/manage?token=${token}`;
}

/**
 * Verifies a signed appointment-manage link token and returns the
 * appointmentId it grants access to. Rejects (401) if the token is invalid/
 * expired, or (403) if it was issued for a different tenant than the one
 * resolved from the URL - same "tampering doesn't help you" shape as
 * requireAuth()'s tenant-mismatch check, just for an unauthenticated link
 * instead of a logged-in session.
 */
function verifyManageToken({ tenantId, token }) {
  let payload;
  try {
    payload = verifyAppointmentManageToken(token);
  } catch {
    throw ApiError.unauthorized('This link is invalid or has expired');
  }
  if (String(payload.tenantId) !== String(tenantId)) {
    throw ApiError.forbidden('This link does not belong to this business', { code: 'TENANT_MISMATCH' });
  }
  return payload.sub;
}

async function getTenantBookingConfig(tenantId) {
  // Tenant is not tenant-scoped (it IS the tenant) - fine to query by id
  // directly, no ambient tenant context required for this lookup.
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return tenant;
}

async function assertNoConflict({ staffMemberId, startTime, endTime, excludeAppointmentId }) {
  const conflictFilter = {
    staffMemberId,
    status: { $in: OPEN_STATUSES },
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  };
  if (excludeAppointmentId) conflictFilter._id = { $ne: excludeAppointmentId };

  const conflict = await Appointment.findOne(conflictFilter);
  if (conflict) {
    throw ApiError.conflict('This time slot is no longer available for the selected staff member.', {
      code: 'SLOT_CONFLICT',
    });
  }
}

async function computeServiceSummary(serviceIds) {
  if (!serviceIds?.length) throw ApiError.badRequest('At least one service must be selected');
  const services = await Service.find({ _id: { $in: serviceIds }, active: true });
  if (services.length !== new Set(serviceIds.map(String)).size) {
    throw ApiError.badRequest('One or more selected services are invalid or inactive');
  }
  const durationMinutes = services.reduce((sum, s) => sum + s.durationMinutes, 0);
  const price = services.reduce((sum, s) => sum + s.price, 0);
  return { durationMinutes, price, services };
}

/**
 * Open slots for a given day, for staff who offer every selected service.
 * Slot duration is the sum of the selected services' durations (one staff
 * member performs all of them back-to-back in a single appointment - see
 * Appointment: one staffMemberId, many serviceIds). Public + staff-facing;
 * always enforces the same-day cutoff since this is "what can a customer
 * book right now", not a staff override of that rule.
 */
export async function getAvailability({ tenantId, date, serviceIds, staffMemberId }) {
  const tenant = await getTenantBookingConfig(tenantId);
  const { durationMinutes } = await computeServiceSummary(serviceIds);

  const dayStart = DateTime.fromISO(date, { zone: tenant.timezone }).startOf('day');
  if (!dayStart.isValid) throw ApiError.badRequest('date must be a valid YYYY-MM-DD date');

  const today = DateTime.now().setZone(tenant.timezone).startOf('day');
  if (dayStart < today) {
    return { date, durationMinutes, staff: [] };
  }

  const now = new Date();
  const cutoffPassed = isSameDayCutoffPassed({
    timezone: tenant.timezone,
    cutoffTime: tenant.bookingRules.sameDayCutoffTime,
    requestedStart: dayStart.toJSDate(),
    now,
  });
  if (cutoffPassed) {
    return { date, durationMinutes, staff: [] };
  }

  const staffFilter = { active: true, servicesOffered: { $all: serviceIds } };
  if (staffMemberId) staffFilter._id = staffMemberId;
  const staffMembers = await StaffMember.find(staffFilter);
  if (!staffMembers.length) return { date, durationMinutes, staff: [] };

  const dayEnd = dayStart.plus({ days: 1 });
  const weekdayKey = dayStart.toFormat('ccc').toLowerCase(); // "mon".."sun" - matches StaffMember.workingHours keys

  const dayAppointments = await Appointment.find({
    staffMemberId: { $in: staffMembers.map((s) => s._id) },
    status: { $in: OPEN_STATUSES },
    startTime: { $lt: dayEnd.toJSDate() },
    endTime: { $gt: dayStart.toJSDate() },
  });
  const bookedRangesByStaff = new Map();
  for (const apt of dayAppointments) {
    const key = String(apt.staffMemberId);
    if (!bookedRangesByStaff.has(key)) bookedRangesByStaff.set(key, []);
    bookedRangesByStaff.get(key).push([apt.startTime.getTime(), apt.endTime.getTime()]);
  }

  const timeOffByStaff = await getTimeOffRangesByStaff({
    staffMemberIds: staffMembers.map((s) => s._id),
    date,
    dayStart,
  });

  const staff = staffMembers.map((member) => {
    const timeOff = timeOffByStaff.get(String(member._id));
    if (timeOff === 'full-day') {
      return { staffMemberId: member._id, name: member.name, slots: [] };
    }

    const ranges = member.workingHours?.[weekdayKey] || [];
    const bookedRanges = bookedRangesByStaff.get(String(member._id)) || [];
    const timeOffRanges = Array.isArray(timeOff) ? timeOff : [];
    const excludedRanges = [...bookedRanges, ...timeOffRanges];
    const slots = [];

    for (const range of ranges) {
      const rangeStartMin = timeStringToMinutes(range.start);
      const rangeEndMin = timeStringToMinutes(range.end);
      for (let m = rangeStartMin; m + durationMinutes <= rangeEndMin; m += SLOT_GRANULARITY_MINUTES) {
        const slotStart = dayStart.plus({ minutes: m });
        const slotStartMs = slotStart.toMillis();
        if (slotStartMs <= now.getTime()) continue;

        const slotEndMs = slotStart.plus({ minutes: durationMinutes }).toMillis();
        const overlapsExisting = excludedRanges.some(([bStart, bEnd]) => slotStartMs < bEnd && slotEndMs > bStart);
        if (overlapsExisting) continue;

        slots.push(slotStart.toISO());
      }
    }

    return { staffMemberId: member._id, name: member.name, slots };
  });

  return { date, durationMinutes, staff };
}

export async function listAppointments({ from, to, staffMemberId, status, customerId } = {}) {
  const filter = {};
  if (from || to) {
    filter.startTime = {};
    if (from) filter.startTime.$gte = new Date(from);
    if (to) filter.startTime.$lte = new Date(to);
  }
  if (staffMemberId) filter.staffMemberId = staffMemberId;
  if (status) filter.status = status;
  if (customerId) filter.customerId = customerId;

  return Appointment.find(filter).sort({ startTime: 1 }).populate('customerId staffMemberId serviceIds');
}

export async function getAppointmentById(id) {
  const appointment = await Appointment.findById(id).populate('customerId staffMemberId serviceIds');
  if (!appointment) throw ApiError.notFound('Appointment not found');
  return appointment;
}

/**
 * enforceBookingRules is true for the public customer-facing booking flow
 * and false for staff/owner creating a booking from the admin dashboard
 * (a walk-in or phone booking taken by the business itself isn't subject to
 * the same-day cutoff meant to stop *customers* self-booking too late).
 */
/**
 * initialStatus/sendConfirmation exist for services/depositService.js: a
 * deposit-gated booking is created as 'pending_payment' (holds the slot,
 * nothing sent yet) and only becomes a real, confirmed booking - at which
 * point the normal confirmation notification goes out - once Yoco's webhook
 * confirms the deposit landed. Every other caller keeps today's behavior.
 */
export async function createAppointment({
  req,
  tenantId,
  actorUserId = null,
  enforceBookingRules,
  data,
  initialStatus = 'booked',
  sendConfirmation = true,
}) {
  const { staffMemberId, serviceIds, startTime, customerId, customerDetails, notes } = data;

  const tenant = await getTenantBookingConfig(tenantId);

  const staff = await StaffMember.findOne({ _id: staffMemberId, active: true });
  if (!staff) throw ApiError.badRequest('Selected staff member is not available');

  const { durationMinutes, price, services } = await computeServiceSummary(serviceIds);
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime()) || start <= new Date()) {
    throw ApiError.badRequest('Appointment start time must be a valid time in the future');
  }
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  if (
    enforceBookingRules &&
    isSameDayCutoffPassed({
      timezone: tenant.timezone,
      cutoffTime: tenant.bookingRules.sameDayCutoffTime,
      requestedStart: start,
    })
  ) {
    throw ApiError.badRequest(
      `Same-day bookings close at ${tenant.bookingRules.sameDayCutoffTime}. Please choose another day or contact us directly.`,
      { code: 'SAME_DAY_CUTOFF' }
    );
  }

  await assertNoConflict({ staffMemberId, startTime: start, endTime: end });

  let customer;
  if (customerId) {
    customer = await getCustomerById(customerId);
  } else if (customerDetails?.phone) {
    customer = await findOrCreateByPhone(customerDetails);
  } else {
    throw ApiError.badRequest('customerId or customerDetails.phone is required');
  }

  const appointment = await Appointment.create({
    customerId: customer._id,
    staffMemberId,
    serviceIds,
    startTime: start,
    endTime: end,
    priceSnapshot: price,
    notes: notes || '',
    createdByUserId: actorUserId,
    status: initialStatus,
  });

  await logAudit({
    req,
    actorUserId,
    action: 'appointment.create',
    entityType: 'Appointment',
    entityId: appointment._id,
    diff: { after: appointment.toObject() },
  });

  if (sendConfirmation) {
    // Best-effort - see notificationService.sendBookingConfirmation. A
    // provider outage must never fail a booking that's already been written.
    const manageUrl = buildManageUrl({ tenant, appointment });
    await sendBookingConfirmation({ tenant, appointment, customer, services, staff, manageUrl }).catch((err) => {
      console.error(`[appointmentService] booking confirmation failed: ${err.message}`);
    });
  }

  return appointment;
}

/**
 * Promotes a 'pending_payment' appointment (see createAppointment above) to
 * a real booking once its deposit has actually landed, and sends the
 * confirmation that was deliberately withheld at creation time. Called from
 * services/depositService.js's webhook handler, never directly from a route.
 */
export async function confirmPendingPaymentAppointment(appointmentId) {
  const appointment = await Appointment.findOne({ _id: appointmentId, status: 'pending_payment' })
    .populate('customerId staffMemberId serviceIds');
  if (!appointment) return null; // already confirmed/cancelled, or webhook arrived twice - not an error

  appointment.status = 'booked';
  await appointment.save();

  const tenant = await getTenantBookingConfig(appointment.tenantId);
  const manageUrl = buildManageUrl({ tenant, appointment });
  await sendBookingConfirmation({
    tenant,
    appointment,
    customer: appointment.customerId,
    services: appointment.serviceIds,
    staff: appointment.staffMemberId,
    manageUrl,
  }).catch((err) => {
    console.error(`[appointmentService] booking confirmation failed: ${err.message}`);
  });

  return appointment;
}

/**
 * The other side of a 'pending_payment' appointment: the deposit failed, was
 * cancelled by the customer, or the checkout simply expired unattended -
 * either way the held slot must be released. Idempotent, same reasoning as
 * confirmPendingPaymentAppointment above.
 */
export async function releasePendingPaymentAppointment(appointmentId) {
  await Appointment.updateOne(
    { _id: appointmentId, status: 'pending_payment' },
    { status: 'cancelled', cancelledAt: new Date(), cancelledReason: 'Deposit payment was not completed' }
  );
}

export async function rescheduleAppointment({
  req,
  tenantId,
  actorUserId = null,
  actorType = 'user',
  actorCustomerId = null,
  id,
  newStartTime,
  enforceBookingRules,
}) {
  const appointment = await Appointment.findById(id);
  if (!appointment) throw ApiError.notFound('Appointment not found');
  if (FINAL_STATUSES.includes(appointment.status)) {
    throw ApiError.badRequest('This appointment can no longer be rescheduled');
  }

  const tenant = await getTenantBookingConfig(tenantId);

  if (
    enforceBookingRules &&
    isWithinChangeWindow({
      windowHours: tenant.bookingRules.rescheduleWindowHours,
      appointmentStart: appointment.startTime,
    })
  ) {
    throw ApiError.badRequest(
      `Appointments can only be rescheduled at least ${tenant.bookingRules.rescheduleWindowHours} hours in advance. Please contact us directly.`,
      { code: 'RESCHEDULE_WINDOW' }
    );
  }

  const durationMs = appointment.endTime.getTime() - appointment.startTime.getTime();
  const newStart = new Date(newStartTime);
  if (Number.isNaN(newStart.getTime()) || newStart <= new Date()) {
    throw ApiError.badRequest('New start time must be a valid time in the future');
  }
  const newEnd = new Date(newStart.getTime() + durationMs);

  await assertNoConflict({
    staffMemberId: appointment.staffMemberId,
    startTime: newStart,
    endTime: newEnd,
    excludeAppointmentId: appointment._id,
  });

  const previousStart = appointment.startTime;
  appointment.rescheduleHistory.push({ from: previousStart, to: newStart, changedBy: actorUserId });
  appointment.startTime = newStart;
  appointment.endTime = newEnd;
  await appointment.save();

  await logAudit({
    req,
    actorUserId,
    actorType,
    actorCustomerId,
    action: 'appointment.reschedule',
    entityType: 'Appointment',
    entityId: appointment._id,
    diff: { before: { startTime: previousStart }, after: { startTime: newStart } },
  });

  return appointment;
}

/**
 * enforceBookingRules mirrors createAppointment/rescheduleAppointment: true
 * for the customer-facing signed-link cancel flow, false for staff/owner
 * cancelling from the dashboard (the business can cancel on a customer's
 * behalf at any time - the cancellation window exists to stop a customer
 * self-cancelling too close to their appointment, not to stop the business).
 */
export async function cancelAppointment({
  req,
  tenantId,
  actorUserId = null,
  actorType = 'user',
  actorCustomerId = null,
  id,
  reason,
  enforceBookingRules = false,
}) {
  const appointment = await Appointment.findById(id);
  if (!appointment) throw ApiError.notFound('Appointment not found');
  if (FINAL_STATUSES.includes(appointment.status)) {
    throw ApiError.badRequest('This appointment has already been finalized');
  }

  if (enforceBookingRules) {
    const tenant = await getTenantBookingConfig(tenantId);
    if (
      isWithinChangeWindow({
        windowHours: tenant.bookingRules.cancellationWindowHours,
        appointmentStart: appointment.startTime,
      })
    ) {
      throw ApiError.badRequest(
        `Appointments can only be cancelled at least ${tenant.bookingRules.cancellationWindowHours} hours in advance. Please contact us directly.`,
        { code: 'CANCELLATION_WINDOW' }
      );
    }
  }

  appointment.status = 'cancelled';
  appointment.cancelledAt = new Date();
  appointment.cancelledReason = reason || null;
  await appointment.save();

  await logAudit({
    req,
    actorUserId,
    actorType,
    actorCustomerId,
    action: 'appointment.cancel',
    entityType: 'Appointment',
    entityId: id,
    diff: { after: { status: 'cancelled', reason: appointment.cancelledReason } },
  });

  return appointment;
}

/**
 * The customer-facing, no-login counterpart to the staff dashboard's
 * reschedule/cancel routes (see architecture doc §4). All three delegate to
 * the same underlying functions used elsewhere, with enforceBookingRules
 * always true - a customer using their own link is always subject to the
 * tenant's reschedule/cancellation windows, unlike staff acting on the
 * business's behalf.
 */
export async function getAppointmentByManageToken({ tenantId, token }) {
  const appointmentId = verifyManageToken({ tenantId, token });
  return getAppointmentById(appointmentId);
}

export async function rescheduleAppointmentByManageToken({ req, tenantId, token, newStartTime }) {
  const appointmentId = verifyManageToken({ tenantId, token });
  return rescheduleAppointment({ req, tenantId, actorUserId: null, id: appointmentId, newStartTime, enforceBookingRules: true });
}

export async function cancelAppointmentByManageToken({ req, tenantId, token, reason }) {
  const appointmentId = verifyManageToken({ tenantId, token });
  return cancelAppointment({ req, tenantId, actorUserId: null, id: appointmentId, reason, enforceBookingRules: true });
}

export async function updateAppointmentStatus({ req, actorUserId, id, status }) {
  const appointment = await Appointment.findById(id);
  if (!appointment) throw ApiError.notFound('Appointment not found');
  if (FINAL_STATUSES.includes(appointment.status)) {
    throw ApiError.badRequest('This appointment has already been finalized');
  }

  const before = appointment.status;
  appointment.status = status;
  await appointment.save();

  if (status === 'completed') {
    await earnPointsForCompletedAppointment({ req, appointment });
  }

  await logAudit({
    req,
    actorUserId,
    action: 'appointment.status_change',
    entityType: 'Appointment',
    entityId: id,
    diff: { before: { status: before }, after: { status } },
  });

  return appointment;
}
