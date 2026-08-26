import { DateTime } from 'luxon';
import { Appointment } from '../models/Appointment.js';
import { Payment } from '../models/Payment.js';
import { Customer } from '../models/Customer.js';
import { Tenant } from '../models/Tenant.js';
import { ApiError } from '../lib/ApiError.js';

// Appointments that occupy a real slot but have nothing to collect on yet
// (still mid-checkout) or never will (cancelled/no-show) - excluded from the
// "unpaid" surface, which is meant for real bookings the owner needs to chase.
const UNPAID_ELIGIBLE_STATUSES = ['booked', 'confirmed', 'completed'];

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

async function getTenantTimezone(tenantId) {
  const tenant = await Tenant.findById(tenantId).lean();
  return tenant?.timezone || 'Africa/Johannesburg';
}

// Revenue is what was actually collected (a succeeded Payment), not the
// quoted price on the appointment (Appointment.priceSnapshot) - a booking can
// be confirmed and later cancelled/no-showed with no payment ever recorded.
async function sumSucceededPayments({ from, to }) {
  const [row] = await Payment.aggregate([
    { $match: { status: 'succeeded', createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total || 0;
}

/**
 * Today's snapshot for the Overview stat-card row. Always "as of now" - no
 * date-range parameter, unlike getSummary() below.
 */
export async function getOverview({ tenantId }) {
  const tz = await getTenantTimezone(tenantId);
  const now = DateTime.now().setZone(tz);
  const todayStart = now.startOf('day').toJSDate();
  const todayEnd = now.endOf('day').toJSDate();
  const weekStart = now.startOf('week').toJSDate();
  const monthStart = now.startOf('month').toJSDate();
  const nowJs = now.toJSDate();

  const [
    bookingsToday,
    upcomingCount,
    cancellationsToday,
    noShowsToday,
    unpaidCount,
    revenueToday,
    revenueWeek,
    revenueMonth,
  ] = await Promise.all([
    Appointment.countDocuments({ startTime: { $gte: todayStart, $lte: todayEnd }, status: { $ne: 'cancelled' } }),
    Appointment.countDocuments({ startTime: { $gt: nowJs }, status: { $in: ['pending_payment', 'booked', 'confirmed'] } }),
    Appointment.countDocuments({ status: 'cancelled', cancelledAt: { $gte: todayStart, $lte: todayEnd } }),
    Appointment.countDocuments({ status: 'no_show', startTime: { $gte: todayStart, $lte: todayEnd } }),
    Appointment.countDocuments({ paymentStatus: 'unpaid', status: { $in: UNPAID_ELIGIBLE_STATUSES } }),
    sumSucceededPayments({ from: todayStart, to: todayEnd }),
    sumSucceededPayments({ from: weekStart, to: nowJs }),
    sumSucceededPayments({ from: monthStart, to: nowJs }),
  ]);

  return { bookingsToday, upcomingCount, cancellationsToday, noShowsToday, unpaidCount, revenueToday, revenueWeek, revenueMonth };
}

/**
 * Real bookings with nothing collected yet, oldest appointment first (the
 * ones most overdue for follow-up). Powers the Overview page's "Unpaid
 * Appointments" review table.
 */
export async function getUnpaidAppointments({ limit = 100 } = {}) {
  return Appointment.find({ paymentStatus: 'unpaid', status: { $in: UNPAID_ELIGIBLE_STATUSES } })
    .sort({ startTime: 1 })
    .limit(limit)
    .populate('customerId staffMemberId serviceIds');
}

/**
 * Date-ranged summary for the Analytics page: 5 stat tiles + 2 daily series.
 * dailyBookings/dailyRevenue are sparse - $group only emits days that had at
 * least one matching document, so the caller must zero-fill missing days
 * before charting a continuous axis.
 */
export async function getSummary({ tenantId, range }) {
  const days = RANGE_DAYS[range];
  if (!days) throw ApiError.badRequest('range must be one of 7d, 30d, 90d, 1y');

  const tz = await getTenantTimezone(tenantId);
  const now = DateTime.now().setZone(tz);
  const from = now.minus({ days: days - 1 }).startOf('day').toJSDate();
  const to = now.endOf('day').toJSDate();

  const [
    combinedRevenue,
    dailyRevenue,
    dailyBookings,
    bookingsCount,
    finalizedCounts,
    totalClients,
    loyaltyMembers,
  ] = await Promise.all([
    sumSucceededPayments({ from, to }),
    Payment.aggregate([
      { $match: { status: 'succeeded', createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', amount: 1 } },
    ]),
    Appointment.aggregate([
      { $match: { startTime: { $gte: from, $lte: to }, status: { $ne: 'pending_payment' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startTime', timezone: tz } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', count: 1 } },
    ]),
    Appointment.countDocuments({ startTime: { $gte: from, $lte: to }, status: { $ne: 'pending_payment' } }),
    Appointment.aggregate([
      { $match: { startTime: { $gte: from, $lte: to }, status: { $in: ['completed', 'cancelled', 'no_show'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Appointment.aggregate([
      { $match: { startTime: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$customerId' } },
      { $count: 'total' },
    ]).then((rows) => rows[0]?.total || 0),
    // Cumulative membership snapshot ("how many members do we have"), not
    // range-filtered ("how many earned points in this window").
    Customer.countDocuments({ loyaltyPoints: { $gt: 0 } }),
  ]);

  const counts = { completed: 0, cancelled: 0, no_show: 0 };
  for (const row of finalizedCounts) counts[row._id] = row.count;
  const finalizedTotal = counts.completed + counts.cancelled + counts.no_show;
  const completionRate = finalizedTotal > 0 ? Math.round((counts.completed / finalizedTotal) * 1000) / 10 : 0;

  return { range, combinedRevenue, bookingsCount, totalClients, completionRate, loyaltyMembers, dailyBookings, dailyRevenue };
}
