import { DateTime } from 'luxon';
import { getDecryptedCredential } from './integrationCredentialService.js';
import { sendWhatsAppMessage } from '../lib/providers/watiClient.js';
import { sendEmail } from '../lib/providers/resendClient.js';
import { env } from '../config/env.js';

async function sendViaWhatsApp({ customer, message }) {
  if (!customer.phone) return;
  try {
    const credential = await getDecryptedCredential('wati');
    if (!credential) return; // tenant hasn't connected WATI - nothing to send
    await sendWhatsAppMessage({
      apiEndpoint: credential.apiEndpoint,
      accessToken: credential.accessToken,
      phone: customer.phone,
      message,
    });
  } catch (err) {
    // A failed notification must never fail the booking itself - see caller.
    console.error(`[notificationService] WhatsApp send failed: ${err.message}`);
  }
}

/**
 * Prefers the tenant's own connected Resend credential; falls back to
 * PLATFORM_RESEND_API_KEY/FROM_EMAIL (see env.js) when the tenant hasn't
 * connected one. That fallback exists because Resend can only ever send
 * "from" a domain someone has actually verified with DNS records
 * (connectResendCredential enforces this at connect time) - a small salon
 * with no domain of its own would otherwise have no way to receive booking
 * confirmations, password resets, or staff invites at all. Returns null
 * (meaning: don't send) only when neither is available.
 */
async function resolveEmailSender(tenant) {
  const own = await getDecryptedCredential('resend');
  if (own) return { apiKey: own.apiKey, from: own.fromEmail };

  if (env.PLATFORM_RESEND_API_KEY && env.PLATFORM_RESEND_FROM_EMAIL) {
    return { apiKey: env.PLATFORM_RESEND_API_KEY, from: `${tenant.displayName} via PackStack <${env.PLATFORM_RESEND_FROM_EMAIL}>` };
  }

  return null;
}

async function sendViaEmail({ tenant, to, subject, message }) {
  if (!to) return;
  try {
    const sender = await resolveEmailSender(tenant);
    if (!sender) return; // neither the tenant's own Resend nor the platform fallback is configured
    await sendEmail({ apiKey: sender.apiKey, from: sender.from, to, subject, html: `<p>${message}</p>` });
  } catch (err) {
    console.error(`[notificationService] Email send failed: ${err.message}`);
  }
}

/**
 * Fires a booking confirmation over whichever channels are available
 * (WhatsApp via WATI if connected, email via the resolved sender above, both,
 * or neither). Always resolves; per-channel failures are caught and logged
 * rather than thrown, so a provider outage never fails the appointment write
 * that already happened.
 */
export async function sendBookingConfirmation({ tenant, appointment, customer, services, staff, manageUrl }) {
  const start = DateTime.fromJSDate(appointment.startTime, { zone: tenant.timezone });
  const serviceNames = services.map((s) => s.name).join(', ');
  const message =
    `Hi ${customer.name}, your ${serviceNames} appointment at ${tenant.displayName} is confirmed for ` +
    `${start.toFormat('cccc, d LLLL')} at ${start.toFormat('HH:mm')} with ${staff?.name || 'our team'}. ` +
    `Need to reschedule or cancel? ${manageUrl}`;

  await Promise.all([
    sendViaWhatsApp({ customer, message }),
    sendViaEmail({ tenant, to: customer.email, subject: `Booking confirmed - ${tenant.displayName}`, message }),
  ]);
}

/**
 * Same best-effort, never-throws contract as sendBookingConfirmation -
 * customerAuthService.js#requestPasswordReset always reports success to the
 * caller regardless of whether this actually goes out, both to avoid leaking
 * which emails have accounts and because no email sender being available
 * shouldn't turn into a 500 on this endpoint. Email only, unlike the
 * WhatsApp+email pair above - a password reset link isn't something to hand
 * out over a channel as easily spoofed/screenshotted-and-shared as WhatsApp.
 */
export async function sendPasswordResetEmail({ tenant, customer, resetUrl }) {
  const message =
    `Hi ${customer.name}, we received a request to reset your password for your ${tenant.displayName} account. ` +
    `Reset it here: ${resetUrl} - this link expires in 30 minutes. If you didn't request this, you can ignore this email.`;

  await sendViaEmail({ tenant, to: customer.email, subject: `Reset your password - ${tenant.displayName}`, message });
}

/**
 * Same best-effort, never-throws contract as sendPasswordResetEmail - and
 * the same reason staffService.js#inviteStaffUser also hands the owner the
 * raw inviteUrl back in the API response rather than relying on this alone:
 * a staff member shouldn't be left with no way to ever get in just because
 * no email sender is configured.
 */
export async function sendStaffInviteEmail({ tenant, email, name, inviteUrl }) {
  const message =
    `Hi ${name}, ${tenant.displayName} has invited you to their PackStack dashboard. ` +
    `Set your password to get started: ${inviteUrl} - this link expires in 7 days.`;

  await sendViaEmail({ tenant, to: email, subject: `You've been invited to ${tenant.displayName}'s dashboard`, message });
}

/**
 * Same best-effort, never-throws contract as sendBookingConfirmation - fired
 * by services/reminderService.js roughly 24h ahead of the appointment.
 */
export async function sendAppointmentReminder({ tenant, appointment, customer, services, staff, manageUrl }) {
  const start = DateTime.fromJSDate(appointment.startTime, { zone: tenant.timezone });
  const serviceNames = services.map((s) => s.name).join(', ');
  const message =
    `Hi ${customer.name}, just a reminder - your ${serviceNames} appointment at ${tenant.displayName} is ` +
    `tomorrow, ${start.toFormat('cccc, d LLLL')} at ${start.toFormat('HH:mm')} with ${staff?.name || 'our team'}. ` +
    `Need to reschedule or cancel? ${manageUrl}`;

  await Promise.all([
    sendViaWhatsApp({ customer, message }),
    sendViaEmail({ tenant, to: customer.email, subject: `Reminder: your appointment tomorrow - ${tenant.displayName}`, message }),
  ]);
}
