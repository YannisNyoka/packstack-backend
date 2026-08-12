import { Tenant } from '../models/Tenant.js';
import { Appointment } from '../models/Appointment.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { sendAppointmentReminder } from './notificationService.js';
import { buildManageUrl } from './appointmentService.js';

// Any appointment starting within this many hours, that hasn't had a
// reminder sent yet, is "due" - a wide window rather than a narrow one
// timed to the sweep's own cadence, so a missed or delayed run never causes
// a reminder to be skipped entirely (reminderSentAt is what actually
// prevents duplicates, not the window).
const REMINDER_LEAD_HOURS = 24;

/**
 * Sends the "your appointment is tomorrow" reminder for every tenant, once
 * per appointment (guarded by Appointment.reminderSentAt). Meant to run via
 * a scheduled job (see jobs/sendAppointmentReminders.js) - same
 * "loop every tenant, bind its own context" shape as
 * depositService.releaseStalePendingPayments and
 * billingService.expirePastDueSubscriptions.
 */
export async function sendDueReminders() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + REMINDER_LEAD_HOURS * 60 * 60 * 1000);
  const tenants = await Tenant.find({}).select('_id slug displayName timezone').lean();
  let sentCount = 0;

  for (const tenant of tenants) {
    await runWithTenant(tenant._id, async () => {
      const due = await Appointment.find({
        status: { $in: ['booked', 'confirmed'] },
        startTime: { $gt: now, $lte: cutoff },
        reminderSentAt: null,
      }).populate('customerId staffMemberId serviceIds');

      for (const appointment of due) {
        const manageUrl = buildManageUrl({ tenant, appointment });
        await sendAppointmentReminder({
          tenant,
          appointment,
          customer: appointment.customerId,
          services: appointment.serviceIds,
          staff: appointment.staffMemberId,
          manageUrl,
        }).catch((err) => {
          console.error(`[reminderService] reminder send failed for appointment ${appointment._id}: ${err.message}`);
        });

        // Marked sent regardless of per-channel failure above (same
        // best-effort contract as booking confirmations) - a WATI/Resend
        // outage should delay the next booking's reminder, not cause this
        // one to be resent indefinitely once channels recover.
        appointment.reminderSentAt = new Date();
        await appointment.save();
        sentCount += 1;
      }
    });
  }

  return { checkedTenants: tenants.length, sentCount };
}
