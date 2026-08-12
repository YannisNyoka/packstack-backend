import { Customer } from '../models/Customer.js';
import { LoyaltyTransaction } from '../models/LoyaltyTransaction.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

// 1 point per R10 spent. Not tenant-configurable in Phase 1 - only the
// booking rules (reschedule window, same-day cutoff) were called out as
// needing to be per-tenant config; revisit if a tenant actually needs a
// different earn rate.
const POINTS_PER_CURRENCY_UNIT = 1 / 10;

export async function earnPointsForCompletedAppointment({ req, appointment }) {
  const pointsEarned = Math.floor(appointment.priceSnapshot * POINTS_PER_CURRENCY_UNIT);
  if (pointsEarned <= 0) return;

  await LoyaltyTransaction.create({
    customerId: appointment.customerId,
    pointsDelta: pointsEarned,
    reason: 'earned_booking',
    relatedAppointmentId: appointment._id,
  });
  await Customer.findByIdAndUpdate(appointment.customerId, { $inc: { loyaltyPoints: pointsEarned } });

  await logAudit({
    req,
    action: 'loyalty.earned',
    entityType: 'Customer',
    entityId: appointment.customerId,
    diff: { after: { pointsEarned, relatedAppointmentId: appointment._id } },
  });
}

export async function redeemPoints({ req, actorUserId, customerId, points, relatedAppointmentId = null }) {
  if (points <= 0) throw ApiError.badRequest('Points to redeem must be greater than zero');

  const customer = await Customer.findById(customerId);
  if (!customer) throw ApiError.notFound('Customer not found');
  if (customer.loyaltyPoints < points) {
    throw ApiError.badRequest('Customer does not have enough loyalty points', { code: 'INSUFFICIENT_POINTS' });
  }

  customer.loyaltyPoints -= points;
  await customer.save();

  await LoyaltyTransaction.create({
    customerId,
    pointsDelta: -points,
    reason: 'redeemed',
    relatedAppointmentId,
    createdByUserId: actorUserId,
  });

  await logAudit({
    req,
    actorUserId,
    action: 'loyalty.redeemed',
    entityType: 'Customer',
    entityId: customerId,
    diff: { after: { pointsRedeemed: points, relatedAppointmentId } },
  });

  return customer;
}

export async function adjustPoints({ req, actorUserId, customerId, pointsDelta, reasonNote }) {
  const customer = await Customer.findById(customerId);
  if (!customer) throw ApiError.notFound('Customer not found');

  const newBalance = customer.loyaltyPoints + pointsDelta;
  if (newBalance < 0) throw ApiError.badRequest('Adjustment would result in a negative points balance');

  customer.loyaltyPoints = newBalance;
  await customer.save();

  await LoyaltyTransaction.create({
    customerId,
    pointsDelta,
    reason: 'manual_adjustment',
    createdByUserId: actorUserId,
  });

  await logAudit({
    req,
    actorUserId,
    action: 'loyalty.manual_adjustment',
    entityType: 'Customer',
    entityId: customerId,
    diff: { after: { pointsDelta, reasonNote } },
  });

  return customer;
}

export async function getLoyaltyHistory(customerId) {
  return LoyaltyTransaction.find({ customerId }).sort({ createdAt: -1 });
}
