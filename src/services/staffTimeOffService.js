import { StaffTimeOff } from '../models/StaffTimeOff.js';
import { getStaffById } from './staffService.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

export async function listTimeOff({ staffMemberId, from, to }) {
  await getStaffById(staffMemberId); // 404s if this staff member doesn't exist/belong to this tenant

  const filter = { staffMemberId };
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }
  return StaffTimeOff.find(filter).sort({ date: 1 });
}

function assertValidRange({ startTime, endTime }) {
  if ((startTime && !endTime) || (!startTime && endTime)) {
    throw ApiError.badRequest('startTime and endTime must be provided together, or both omitted for a whole-day block');
  }
  if (startTime && endTime && startTime >= endTime) {
    throw ApiError.badRequest('startTime must be before endTime');
  }
}

export async function createTimeOff({ req, actorUserId, staffMemberId, data }) {
  await getStaffById(staffMemberId);
  assertValidRange(data);

  const timeOff = await StaffTimeOff.create({ ...data, staffMemberId });
  await logAudit({
    req,
    actorUserId,
    action: 'staff.time_off.create',
    entityType: 'StaffTimeOff',
    entityId: timeOff._id,
    diff: { after: timeOff.toObject() },
  });
  return timeOff;
}

export async function deleteTimeOff({ req, actorUserId, staffMemberId, id }) {
  const timeOff = await StaffTimeOff.findOneAndDelete({ _id: id, staffMemberId });
  if (!timeOff) throw ApiError.notFound('Time-off entry not found');

  await logAudit({
    req,
    actorUserId,
    action: 'staff.time_off.delete',
    entityType: 'StaffTimeOff',
    entityId: id,
    diff: { before: timeOff.toObject() },
  });
}

/**
 * Used by appointmentService.getAvailability() - returns, per staff member
 * id, either 'full-day' (skip the day entirely) or a list of [startMs, endMs]
 * ranges to treat as occupied alongside existing bookings.
 */
export async function getTimeOffRangesByStaff({ staffMemberIds, date, dayStart }) {
  const entries = await StaffTimeOff.find({ staffMemberId: { $in: staffMemberIds }, date });

  const result = new Map();
  for (const entry of entries) {
    const key = String(entry.staffMemberId);
    if (result.get(key) === 'full-day') continue;

    if (!entry.startTime) {
      result.set(key, 'full-day');
      continue;
    }

    const [startHour, startMinute] = entry.startTime.split(':').map(Number);
    const [endHour, endMinute] = entry.endTime.split(':').map(Number);
    const rangeStart = dayStart.set({ hour: startHour, minute: startMinute }).toMillis();
    const rangeEnd = dayStart.set({ hour: endHour, minute: endMinute }).toMillis();

    const existing = result.get(key);
    const ranges = Array.isArray(existing) ? existing : [];
    ranges.push([rangeStart, rangeEnd]);
    result.set(key, ranges);
  }
  return result;
}
