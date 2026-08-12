import { DateTime } from 'luxon';

/**
 * Rules are read from Tenant.bookingRules (per-tenant config, not code) -
 * this is what makes NXL's "6pm same-day cutoff" and "36h reschedule window"
 * generic defaults rather than hardcoded logic.
 */

export function isSameDayCutoffPassed({ timezone, cutoffTime, requestedStart, now = new Date() }) {
  const zonedNow = DateTime.fromJSDate(now, { zone: timezone });
  const zonedStart = DateTime.fromJSDate(requestedStart, { zone: timezone });
  if (!zonedNow.hasSame(zonedStart, 'day')) return false; // not a same-day booking - cutoff doesn't apply

  const [hour, minute] = cutoffTime.split(':').map(Number);
  const cutoff = zonedNow.set({ hour, minute, second: 0, millisecond: 0 });
  return zonedNow >= cutoff;
}

// Shared by both the reschedule window (rescheduleWindowHours) and the
// cancellation window (cancellationWindowHours) - same "is now within
// windowHours of the appointment" check, just applied against a different
// tenant-configured threshold depending on which action is being guarded.
export function isWithinChangeWindow({ windowHours, appointmentStart, now = new Date() }) {
  const hoursUntilAppointment = (new Date(appointmentStart).getTime() - now.getTime()) / (60 * 60 * 1000);
  return hoursUntilAppointment < windowHours;
}
