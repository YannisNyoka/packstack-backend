import { Tenant } from '../models/Tenant.js';
import { Payment } from '../models/Payment.js';
import { Appointment } from '../models/Appointment.js';
import { getDecryptedCredential } from './integrationCredentialService.js';
import { createAppointment, confirmPendingPaymentAppointment, releasePendingPaymentAppointment } from './appointmentService.js';
import { createCheckout, verifyWebhookSignature } from '../lib/providers/yocoClient.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { env } from '../config/env.js';

const PENDING_PAYMENT_TIMEOUT_MINUTES = 30;

/**
 * A deposit is only actually required once both halves are true: the owner
 * turned it on (Tenant.bookingRules.depositRequired) AND Yoco is actually
 * connected. Turning the toggle on ahead of connecting Yoco is harmless -
 * this just reports "not required" until both are in place, rather than
 * booking pages breaking on a half-configured tenant.
 */
export async function getDepositConfig(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('bookingRules').lean();
  if (!tenant) throw ApiError.notFound('Tenant not found');
  const requireCustomerAccount = tenant.bookingRules.requireCustomerAccount !== false;

  if (!tenant.bookingRules.depositRequired || tenant.bookingRules.depositAmountZAR <= 0) {
    return { required: false, amountZAR: 0, requireCustomerAccount };
  }

  const credential = await getDecryptedCredential('yoco');
  if (!credential) return { required: false, amountZAR: 0, requireCustomerAccount };

  return { required: true, amountZAR: tenant.bookingRules.depositAmountZAR, requireCustomerAccount };
}

/**
 * Holds the slot (a 'pending_payment' appointment - see
 * appointmentService.createAppointment) and starts a Yoco hosted checkout
 * for the deposit. The appointment isn't confirmed and no notification goes
 * out until handleYocoWebhook below hears back that the deposit succeeded -
 * see architecture doc §7's original deferral of this and the NXL feature
 * audit that prompted building it for real.
 */
export async function createDepositCheckout({ req, tenantId, tenantSlug, data }) {
  const { required, amountZAR } = await getDepositConfig(tenantId);
  if (!required) throw ApiError.badRequest('This business does not require a deposit for booking.');

  const credential = await getDecryptedCredential('yoco');

  const appointment = await createAppointment({
    req,
    tenantId,
    actorUserId: null,
    enforceBookingRules: true,
    data,
    initialStatus: 'pending_payment',
    sendConfirmation: false,
  });

  const payment = await Payment.create({
    appointmentId: appointment._id,
    amount: amountZAR,
    method: 'online',
    provider: 'yoco',
    status: 'pending',
  });

  let checkout;
  try {
    checkout = await createCheckout({
      secretKey: credential.secretKey,
      amountZAR,
      successUrl: `https://${tenantSlug}.${env.BASE_DOMAIN}/book?depositSuccess=1`,
      cancelUrl: `https://${tenantSlug}.${env.BASE_DOMAIN}/book?depositCancelled=1`,
      failureUrl: `https://${tenantSlug}.${env.BASE_DOMAIN}/book?depositFailed=1`,
      metadata: { source: 'packstack', paymentId: String(payment._id) },
    });
  } catch (err) {
    // Couldn't even start the checkout - release the slot we just held
    // rather than leaving a dead pending_payment appointment behind.
    await releasePendingPaymentAppointment(appointment._id);
    payment.status = 'failed';
    await payment.save();
    throw ApiError.badRequest(`Could not start payment: ${err.message}`);
  }

  payment.providerTransactionId = checkout.id;
  await payment.save();

  await logAudit({
    req,
    actorUserId: null,
    action: 'payment.checkout_created',
    entityType: 'Payment',
    entityId: payment._id,
    diff: { after: { appointmentId: appointment._id, amount: amountZAR, checkoutId: checkout.id } },
  });

  return { checkoutUrl: checkout.redirectUrl, appointmentId: appointment._id };
}

/**
 * Handles a Yoco webhook call for this tenant. Reconciles purely via
 * payload.metadata.checkoutId - Yoco stamps this onto every payment webhook
 * itself (confirmed against a real payload.succeeded example), matched
 * against the checkout id createDepositCheckout stored as
 * Payment.providerTransactionId. Unrecognized/unmatched events are
 * acknowledged without action so Yoco doesn't keep retrying them - the
 * stale-pending-payment sweep (jobs/expireStalePendingPayments.js) is the
 * real safety net for anything that never resolves this way (declined card,
 * abandoned checkout, an event type this handler doesn't know about yet).
 */
export async function handleYocoWebhook({ headers, rawBody }) {
  const credential = await getDecryptedCredential('yoco');
  if (!credential) throw ApiError.badRequest('Yoco is not connected for this tenant');

  const verified = verifyWebhookSignature({
    webhookId: headers['webhook-id'],
    webhookTimestamp: headers['webhook-timestamp'],
    signatureHeader: headers['webhook-signature'],
    rawBody,
    webhookSecret: credential.webhookSecret,
  });
  if (!verified) throw ApiError.forbidden('Invalid Yoco webhook signature');

  const event = JSON.parse(rawBody);
  if (event.type !== 'payment.succeeded') return { received: true };

  const checkoutId = event.payload?.metadata?.checkoutId;
  if (!checkoutId) return { received: true };

  const payment = await Payment.findOne({ providerTransactionId: checkoutId });
  if (!payment || payment.status === 'succeeded') return { received: true }; // unknown or already-processed - webhooks can arrive more than once

  payment.status = 'succeeded';
  await payment.save();
  await confirmPendingPaymentAppointment(payment.appointmentId);

  return { received: true };
}

/**
 * Reclaims slots held by abandoned deposit checkouts - a customer who closes
 * the Yoco tab, a declined card with no webhook this handler recognizes, or
 * any other way a 'pending_payment' appointment never resolves on its own.
 * Meant to run frequently (every few minutes, not daily like
 * billingService.expirePastDueSubscriptions - an abandoned checkout should
 * free the slot quickly, not sit on it for a day) via an external scheduler;
 * see jobs/expireStalePendingPayments.js.
 */
export async function releaseStalePendingPayments() {
  const cutoff = new Date(Date.now() - PENDING_PAYMENT_TIMEOUT_MINUTES * 60_000);
  const tenants = await Tenant.find({}).select('_id').lean();
  let releasedCount = 0;

  for (const tenant of tenants) {
    await runWithTenant(tenant._id, async () => {
      const stale = await Appointment.find({ status: 'pending_payment', createdAt: { $lt: cutoff } }).select('_id');
      for (const appointment of stale) {
        await releasePendingPaymentAppointment(appointment._id);
        await Payment.updateMany({ appointmentId: appointment._id, status: 'pending' }, { status: 'failed' });
        releasedCount += 1;
      }
    });
  }

  return { checkedTenants: tenants.length, releasedCount };
}
