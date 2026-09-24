import { DateTime } from 'luxon';
import * as Sentry from '@sentry/node';
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
import { sendBookingConfirmation, sendDepositConflictNotice } from './notificationService.js';
import { signAppointmentManageToken, verifyAppointmentManageToken } from '../lib/jwt.js';
import { env } from '../config/env.js';

// Deliberately does NOT include 'pending_payment': a deposit checkout in
// flight must never block the slot for anyone else - a customer who starts
// paying and abandons it (closes the tab, declined card, or just never
// finishes) must not be able to sit on a slot other customers can see and
// want. Multiple customers can therefore hold simultaneous pending_payment
// appointments for the very same slot; only one of them can actually win it
// once a deposit lands - see confirmPendingPaymentAppointment below, which
// re-checks this same list at confirmation time (the moment that actually
// matters) rather than relying on a reservation made before payment even
// started.
const SLOT_BLOCKING_STATUSES = ['booked', 'confirmed'];
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
    status: { $in: SLOT_BLOCKING_STATUSES },
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

const SLOT_CONFLICT_ERROR = () =>
  ApiError.conflict('This time slot is no longer available for the selected staff member.', { code: 'SLOT_CONFLICT' });

/**
 * The check above and this Mongo-level constraint (see Appointment's unique
 * partial index) are two layers of the same guarantee, not redundant: the
 * check above is a best-effort pre-flight that gives a fast, friendly error
 * in the overwhelmingly common case, but leaves a real gap between the
 * check and the write two requests can both pass for the exact same
 * staff+start (the common race, since slots sit on a fixed grid). Only the
 * unique index actually closes that gap - the loser's write throws a Mongo
 * duplicate-key error (code 11000), which this turns into the same
 * SLOT_CONFLICT response the pre-flight check itself returns, so the
 * caller/frontend never has to know which layer caught it.
 */
function isDuplicateSlotError(err) {
  return err?.code === 11000;
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
    status: { $in: SLOT_BLOCKING_STATUSES },
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
 * deposit-gated booking is created as 'pending_payment' (does NOT hold the
 * slot - see SLOT_BLOCKING_STATUSES above - nothing sent yet) and only
 * becomes a real, confirmed booking - at which point the normal confirmation
 * notification goes out - once Yoco's webhook confirms the deposit landed
 * AND the slot is re-checked as still free; see
 * confirmPendingPaymentAppointment below. Every other caller keeps today's
 * behavior.
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

  let appointment;
  try {
    appointment = await Appointment.create({
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
  } catch (err) {
    if (isDuplicateSlotError(err)) throw SLOT_CONFLICT_ERROR();
    throw err;
  }

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

const SLOT_TAKEN_CANCEL_REASON = 'This slot was taken by someone else before your deposit was confirmed.';

/**
 * A paid deposit that can't actually be honored is a real money problem,
 * not a routine booking conflict - loud on purpose (console.error alone
 * isn't reliably monitored; this needs a human to see it and issue a refund
 * through Yoco directly, since this codebase has no refund API call).
 * Shared by both places confirmPendingPaymentAppointment below can discover
 * this: right when it tries to confirm and finds the slot just went to
 * someone else, and when a webhook for an already-cancelled appointment
 * (proactively cancelled because a sibling won the same slot first, or
 * released by the stale-payment sweep) turns out to have actually succeeded
 * after all.
 */
async function flagUnhonorableDeposit(appointment, tenant) {
  console.error(
    `[appointmentService] Deposit paid but appointment ${appointment._id} could not be honored (status: ${appointment.status}) - needs a manual refund.`
  );
  Sentry.captureMessage('Paid deposit could not be honored - manual refund needed', {
    level: 'error',
    extra: { appointmentId: String(appointment._id), tenantId: String(appointment.tenantId), status: appointment.status },
  });

  await logAudit({
    actorType: 'superadmin', // no logged-in user/customer - the Yoco webhook triggered this, same convention as billingService.js's ITN handling
    action: 'appointment.deposit_conflict_cancelled',
    entityType: 'Appointment',
    entityId: appointment._id,
    diff: { after: { status: appointment.status } },
  });

  await sendDepositConflictNotice({ tenant, customer: appointment.customerId }).catch((notifyErr) => {
    console.error(`[appointmentService] deposit conflict notice failed: ${notifyErr.message}`);
  });
}

/**
 * Promotes a 'pending_payment' appointment (see createAppointment above) to
 * a real booking once its deposit has actually landed, and sends the
 * confirmation that was deliberately withheld at creation time. Called from
 * services/depositService.js's webhook handler, never directly from a route.
 *
 * Since a pending_payment appointment never held the slot (see
 * SLOT_BLOCKING_STATUSES above), someone else can have booked/confirmed the
 * exact same slot while this deposit was in flight - the money has already
 * moved by the time this runs (Yoco already reported success), so this is
 * the one place that race can actually surface. Re-checks for a conflict
 * right here, at the only point it actually matters, rather than trusting a
 * reservation made before payment even started. A real conflict cancels
 * this appointment instead of confirming it and reports which happened, so
 * the caller (depositService.js) can tell the customer their money is safe
 * but the slot is gone rather than silently double-booking or going quiet.
 *
 * On success, also proactively cancels every OTHER pending_payment
 * appointment still sitting on this exact same slot - other customers who
 * started a checkout for it but haven't paid yet, so their hold doesn't
 * linger only to be discovered as a conflict later. If one of them turns
 * out to have already paid (their own webhook arrives after this), the
 * fallback branch below still catches it and flags it the same way,
 * exactly like a conflict discovered at confirmation time - a cancelled
 * appointment must never silently swallow a successful charge.
 */
export async function confirmPendingPaymentAppointment(appointmentId) {
  const appointment = await Appointment.findById(appointmentId).populate('customerId staffMemberId serviceIds');
  if (!appointment) return null; // no such appointment at all - not an error

  if (appointment.status === 'booked') {
    return { appointment, confirmed: true }; // already confirmed - webhook arrived twice, idempotent no-op
  }

  const tenant = await getTenantBookingConfig(appointment.tenantId);

  if (appointment.status === 'cancelled') {
    // A webhook reporting success for an appointment that's already
    // cancelled (by the block below, or by the stale-payment sweep) means
    // the charge went through anyway - flag it regardless of why it was
    // cancelled, rather than only for the slot-conflict case.
    await flagUnhonorableDeposit(appointment, tenant);
    return { appointment, confirmed: false };
  }

  if (appointment.status !== 'pending_payment') return null; // some other status - nothing this function should touch

  try {
    await assertNoConflict({
      staffMemberId: appointment.staffMemberId._id,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
    });
    appointment.status = 'booked';
    await appointment.save();
  } catch (err) {
    if (!isDuplicateSlotError(err) && !(err instanceof ApiError && err.code === 'SLOT_CONFLICT')) throw err;

    appointment.status = 'cancelled';
    appointment.cancelledAt = new Date();
    appointment.cancelledReason = SLOT_TAKEN_CANCEL_REASON;
    await appointment.save();

    await flagUnhonorableDeposit(appointment, tenant);
    return { appointment, confirmed: false };
  }

  // Won the slot - anyone else still holding a pending_payment appointment
  // for this exact same staff+time never had a chance and should stop
  // lingering, rather than only being discovered as a conflict if/when
  // their own deposit happens to land too.
  await Appointment.updateMany(
    {
      _id: { $ne: appointment._id },
      staffMemberId: appointment.staffMemberId._id,
      startTime: appointment.startTime,
      status: 'pending_payment',
    },
    { status: 'cancelled', cancelledAt: new Date(), cancelledReason: SLOT_TAKEN_CANCEL_REASON }
  );

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

  return { appointment, confirmed: true };
}

/**
 * The other side of a 'pending_payment' appointment: the deposit failed, was
 * cancelled by the customer, or the checkout simply expired unattended -
 * either way it needs to be cancelled so it stops showing up as a live
 * appointment (it was never blocking anyone else's slot - see
 * SLOT_BLOCKING_STATUSES above - but it's still a real record that needs
 * cleaning up). Idempotent, same reasoning as confirmPendingPaymentAppointment above.
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
  try {
    await appointment.save();
  } catch (err) {
    if (isDuplicateSlotError(err)) throw SLOT_CONFLICT_ERROR();
    throw err;
  }

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
