import { DateTime } from 'luxon';
import { getDecryptedCredential } from './integrationCredentialService.js';
import { sendWhatsAppMessage } from '../lib/providers/watiClient.js';
import { sendEmail } from '../lib/providers/resendClient.js';

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

async function sendViaEmail({ customer, subject, message }) {
  if (!customer.email) return;
  try {
    const credential = await getDecryptedCredential('resend');
    if (!credential) return; // tenant hasn't connected Resend - nothing to send
    await sendEmail({
      apiKey: credential.apiKey,
      from: credential.fromEmail,
      to: customer.email,
      subject,
      html: `<p>${message}</p>`,
    });
  } catch (err) {
    console.error(`[notificationService] Email send failed: ${err.message}`);
  }
}

/**
 * Fires a booking confirmation over whichever channels the tenant has
 * connected (WhatsApp via WATI, email via Resend, both, or neither - this
 * is a no-op if nothing is connected). Always resolves; per-channel
 * failures are caught and logged rather than thrown, so a provider outage
 * never fails the appointment write that already happened.
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
    sendViaEmail({ customer, subject: `Booking confirmed - ${tenant.displayName}`, message }),
  ]);
}

/**
 * Same best-effort, never-throws contract as sendBookingConfirmation -
 * customerAuthService.js#requestPasswordReset always reports success to the
 * caller regardless of whether this actually goes out, both to avoid leaking
 * which emails have accounts and because a tenant with Resend not connected
 * shouldn't turn into a 500 on this endpoint. Email only, unlike the
 * WhatsApp+email pair above - a password reset link isn't something to hand
 * out over a channel as easily spoofed/screenshotted-and-shared as WhatsApp.
 */
export async function sendPasswordResetEmail({ tenant, customer, resetUrl }) {
  const message =
    `Hi ${customer.name}, we received a request to reset your password for your ${tenant.displayName} account. ` +
    `Reset it here: ${resetUrl} - this link expires in 30 minutes. If you didn't request this, you can ignore this email.`;

  await sendViaEmail({ customer, subject: `Reset your password - ${tenant.displayName}`, message });
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
    sendViaEmail({ customer, subject: `Reminder: your appointment tomorrow - ${tenant.displayName}`, message }),
  ]);
}
