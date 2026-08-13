import { DateTime } from 'luxon';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { Tenant } from '../models/Tenant.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { clearTenantCache } from '../lib/tenantCache.js';
import {
  buildSignature,
  verifyItnSignature,
  validateWithPayfast,
  checkoutUrl,
  cancelPayfastSubscription,
} from '../lib/providers/payfastClient.js';
import { env } from '../config/env.js';

const GRACE_PERIOD_DAYS = 7;
// PayFast's subscription "frequency" codes: 3 = monthly, 6 = annual.
const BILLING_FREQUENCY_CODE = { monthly: 3, annual: 6 };

function requirePayfastConfigured() {
  if (!env.PAYFAST_MERCHANT_ID || !env.PAYFAST_MERCHANT_KEY) {
    throw ApiError.badRequest('PayFast is not configured on this server (PAYFAST_MERCHANT_ID/PAYFAST_MERCHANT_KEY missing)');
  }
}

function computePeriodEnd(plan, from = new Date()) {
  const start = DateTime.fromJSDate(from);
  return (plan.billingInterval === 'annual' ? start.plus({ years: 1 }) : start.plus({ months: 1 })).toJSDate();
}

export async function getSubscription() {
  const subscription = await Subscription.findOne({}).populate('planId');
  if (!subscription) throw ApiError.notFound('No subscription found for this tenant');
  return subscription;
}

/**
 * Creates (or reassigns) the tenant's one Subscription doc for the chosen
 * plan and returns the signed field set the frontend posts/redirects to
 * PayFast's hosted checkout with (architecture doc §7). m_payment_id is the
 * Subscription's own _id, doubling as the idempotency key PayFast round-trips
 * back on the ITN - see handlePayfastItn below.
 */
export async function createCheckoutForPlan({ req, actorUserId, tenantId, tenantSlug, planId }) {
  requirePayfastConfigured();

  const plan = await Plan.findOne({ _id: planId, active: true });
  if (!plan) throw ApiError.badRequest('Selected plan is not available');

  let subscription = await Subscription.findOne({});
  if (subscription) {
    subscription.planId = plan._id;
    await subscription.save();
  } else {
    subscription = await Subscription.create({ planId: plan._id, status: 'trialing' });
  }

  // A subscription that's never been billed yet and still has trial days
  // left (i.e. a fresh signup) gets its card captured today with the real
  // debit deferred to trial end, instead of being charged immediately.
  // PayFast has no built-in "trial" concept - amount:0 plus a future
  // billing_date is its documented way to authorize a card without moving
  // money yet; the real recurring_amount then auto-debits on that date.
  // Not yet exercised against a live PayFast sandbox call - if R0 turns out
  // to be rejected there, switch `amount` to a small nominal charge instead.
  const tenant = await Tenant.findById(tenantId).lean();
  const deferBillingUntil =
    !subscription.currentPeriodEnd && tenant?.trialEndsAt && tenant.trialEndsAt > new Date() ? tenant.trialEndsAt : null;

  const fields = [
    ['merchant_id', env.PAYFAST_MERCHANT_ID],
    ['merchant_key', env.PAYFAST_MERCHANT_KEY],
    ['return_url', `https://${tenantSlug}.${env.BASE_DOMAIN}/billing/success`],
    ['cancel_url', `https://${tenantSlug}.${env.BASE_DOMAIN}/billing/cancelled`],
    ['notify_url', `${env.API_BASE_URL}/api/platform/billing/payfast/itn`],
    ['m_payment_id', String(subscription._id)],
    ['amount', deferBillingUntil ? '0.00' : plan.priceZAR.toFixed(2)],
    ['item_name', `PackStack - ${plan.name}`],
    ['custom_str1', String(tenantId)],
    ['subscription_type', '1'],
    ...(deferBillingUntil ? [['billing_date', DateTime.fromJSDate(deferBillingUntil).toFormat('yyyy-LL-dd')]] : []),
    ['recurring_amount', plan.priceZAR.toFixed(2)],
    ['frequency', String(BILLING_FREQUENCY_CODE[plan.billingInterval] || BILLING_FREQUENCY_CODE.monthly)],
    ['cycles', '0'], // indefinite, until cancelled
  ];
  const signature = buildSignature(fields, env.PAYFAST_PASSPHRASE);

  await logAudit({
    req,
    actorUserId,
    action: 'billing.checkout_created',
    entityType: 'Subscription',
    entityId: subscription._id,
    diff: { after: { planId: plan._id, planKey: plan.key } },
  });

  return { checkoutUrl: checkoutUrl(), fields: Object.fromEntries([...fields, ['signature', signature]]) };
}

/**
 * Cancels the tenant's subscription with PayFast directly (not just locally)
 * so a deferred trial-end debit (see createCheckoutForPlan above) never
 * fires. Tenant.status is deliberately left untouched here - a tenant who
 * cancels mid-trial keeps full access for the rest of it, exactly like any
 * other trial tenant, and expireTrials() below suspends them at trialEndsAt
 * same as usual.
 */
export async function cancelSubscription({ req, actorUserId, tenantId }) {
  const subscription = await Subscription.findOne({});
  if (!subscription) throw ApiError.notFound('No subscription found for this tenant');
  if (subscription.status === 'canceled') throw ApiError.badRequest('This subscription is already cancelled');
  if (!subscription.billingProviderSubscriptionToken) {
    throw ApiError.badRequest('This subscription has no PayFast token yet - nothing to cancel');
  }

  // Skipped only in the test suite (no real PayFast sandbox to call from
  // there) - dev/staging still hit PayFast's actual sandbox, same reasoning
  // as the production-only guard around validateWithPayfast above.
  if (env.NODE_ENV !== 'test') {
    await cancelPayfastSubscription(subscription.billingProviderSubscriptionToken);
  }

  subscription.status = 'canceled';
  subscription.cancelAtPeriodEnd = true;
  await subscription.save();

  await logAudit({
    req,
    actorUserId,
    action: 'billing.subscription_cancelled',
    entityType: 'Subscription',
    entityId: subscription._id,
    diff: { after: { status: 'canceled' } },
  });

  return subscription;
}

/**
 * Processes a PayFast ITN (Instant Transaction Notification). orderedFields
 * must preserve the exact order PayFast posted them in (see
 * routes/platformBillingRoutes.js - Object.entries() on the parsed body,
 * which preserves wire order for non-numeric keys) since the signature is
 * order-sensitive. Resolves which tenant this is for via custom_str1 (set by
 * createCheckoutForPlan above) and runs the actual status transition inside
 * that tenant's context - there is no request-bound tenant here, since
 * PayFast calls this directly with no session/JWT of any kind.
 */
export async function handlePayfastItn({ orderedFields, rawBody }) {
  const fieldsObj = Object.fromEntries(orderedFields);
  const fieldsForSignature = orderedFields.filter(([key]) => key !== 'signature');

  if (!verifyItnSignature(fieldsForSignature, fieldsObj.signature, env.PAYFAST_PASSPHRASE)) {
    throw ApiError.forbidden('Invalid PayFast ITN signature');
  }

  if (env.NODE_ENV === 'production') {
    // Secondary, defense-in-depth check on top of the signature verification
    // above (which is the actual cryptographic guarantee - see
    // payfastClient.js). Log-only, never blocking: confirmed against real
    // PayFast sandbox traffic that this round-trip can come back non-VALID
    // for a genuinely valid, correctly-signed ITN (observed as an immediate
    // 403 in production that then replayed as VALID moments later manually)
    // - a timing/replay quirk on PayFast's side, not evidence of forgery.
    // Hard-failing on it was rejecting real transactions.
    try {
      const valid = await validateWithPayfast(rawBody);
      if (!valid) console.error('[billingService] PayFast server-side ITN validation returned non-VALID for a signature-verified ITN - proceeding anyway.');
    } catch (err) {
      console.error(`[billingService] PayFast server-side ITN validation unreachable: ${err.message}`);
    }
  }

  const tenantId = fieldsObj.custom_str1;
  if (!tenantId) throw ApiError.badRequest('ITN missing custom_str1 (tenantId)');

  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw ApiError.notFound('Tenant not found for this ITN');

  await runWithTenant(tenantId, async () => {
    const subscription = await Subscription.findOne({}).populate('planId');
    if (!subscription || String(subscription._id) !== String(fieldsObj.m_payment_id)) {
      throw ApiError.notFound('No matching subscription for this ITN');
    }

    // PayFast returns a token as soon as a card is authorized, even for the
    // R0 trial-authorization transaction createCheckoutForPlan sends for a
    // fresh signup (no real debit yet) - capture it unconditionally so
    // cancelSubscription() below has something to cancel against before any
    // money has actually moved.
    if (fieldsObj.token) subscription.billingProviderSubscriptionToken = fieldsObj.token;
    if (fieldsObj.pf_payment_id) subscription.billingProviderCustomerId = fieldsObj.pf_payment_id;

    // Subscription.status is the billing source of truth; Tenant.status is
    // the denormalized copy middleware/tenantResolution.js and
    // services/domainService.js actually gate on (they run before/without a
    // bound tenant context in some cases, so they can't join through
    // Subscription). Every transition below keeps both in sync.
    const paymentStatus = fieldsObj.payment_status;
    const amountGross = Number(fieldsObj.amount_gross || 0);

    if (paymentStatus === 'COMPLETE' && amountGross > 0) {
      subscription.status = 'active';
      subscription.currentPeriodEnd = computePeriodEnd(subscription.planId);
      subscription.gracePeriodEndsAt = null;
      await Tenant.findByIdAndUpdate(tenantId, { status: 'active' });
      clearTenantCache(); // tenantResolution.js's slug cache would otherwise keep serving the pre-reactivation status for up to a minute
    } else if (paymentStatus === 'FAILED' && subscription.status === 'active') {
      subscription.status = 'past_due';
      subscription.gracePeriodEndsAt = DateTime.now().plus({ days: GRACE_PERIOD_DAYS }).toJSDate();
      await Tenant.findByIdAndUpdate(tenantId, { status: 'past_due' });
      clearTenantCache();
    } else if (paymentStatus === 'FAILED' && subscription.status === 'trialing') {
      // The deferred trial-end debit itself failed (e.g. card declined) -
      // there's no prior active period to grace-period from, so suspend
      // straight away rather than leaving the tenant on a subscription that
      // will never successfully bill.
      subscription.status = 'suspended';
      await Tenant.findByIdAndUpdate(tenantId, { status: 'suspended' });
      clearTenantCache();
    }
    // 'PENDING', a R0 authorization COMPLETE (amountGross === 0), and
    // anything else: no status transition yet - token capture above already ran.

    await subscription.save();

    await logAudit({
      actorType: 'superadmin', // no logged-in user - PayFast itself triggered this
      action: 'billing.itn_processed',
      entityType: 'Subscription',
      entityId: subscription._id,
      diff: { after: { status: subscription.status, paymentStatus } },
    });
  });

  return { received: true };
}

/**
 * Sweeps every tenant for a past_due subscription whose grace period has
 * expired and suspends it (architecture doc §7). There's no in-process
 * scheduler here (Render runs a single web instance; a setInterval wouldn't
 * survive restarts or scale correctly beyond one) - run this via a Render
 * Cron Job hitting `node src/jobs/expirePastDueSubscriptions.js` on a daily
 * schedule instead. Loops Tenant (not tenant-scoped, safe to list in full)
 * and binds each tenant's own context individually - the "explicit, audited
 * cross-tenant function" tenantContext.js's runAsPlatform() comment calls
 * for, rather than faking a bypass.
 */
/**
 * Sweeps every tenant still in `trial` status whose trialEndsAt
 * (platformService.provisionTenant, set once at provisioning) has passed and
 * suspends them - same restrictions as an unpaid past_due tenant
 * (middleware/enforceTenantStatus.js): public booking blocked, dashboard
 * read-only except /billing so the owner can still subscribe to reactivate.
 * Tenants with no trialEndsAt (provisioned before this field existed) are
 * left alone entirely - see the field's own comment on why.
 * Same "loop every tenant, bind its own context" shape as
 * expirePastDueSubscriptions above; meant to run via a daily Render Cron Job
 * (`npm run trials:expire`).
 *
 * Cutoff is trialEndsAt + a 24h buffer, not trialEndsAt itself: PayFast's
 * deferred trial-end debit (createCheckoutForPlan's billing_date) fires on
 * trialEndsAt too, and its ITN needs a chance to land and activate the
 * subscription before this sweep would otherwise suspend a tenant who's
 * actually about to convert to paid.
 */
export async function expireTrials() {
  const cutoff = DateTime.now().minus({ hours: 24 }).toJSDate();
  const tenants = await Tenant.find({ status: 'trial', trialEndsAt: { $ne: null, $lte: cutoff } }).lean();
  let suspendedCount = 0;

  for (const tenant of tenants) {
    await runWithTenant(tenant._id, async () => {
      await Tenant.findByIdAndUpdate(tenant._id, { status: 'suspended' });
      clearTenantCache();
      suspendedCount += 1;

      await logAudit({
        actorType: 'superadmin',
        action: 'billing.trial_expired',
        entityType: 'Tenant',
        entityId: tenant._id,
        diff: { before: { status: 'trial' }, after: { status: 'suspended' } },
      });
    });
  }

  return { checked: tenants.length, suspendedCount };
}

export async function expirePastDueSubscriptions() {
  const tenants = await Tenant.find({}).lean();
  let suspendedCount = 0;

  for (const tenant of tenants) {
    await runWithTenant(tenant._id, async () => {
      const subscription = await Subscription.findOne({ status: 'past_due' });
      if (!subscription?.gracePeriodEndsAt || subscription.gracePeriodEndsAt > new Date()) return;

      subscription.status = 'suspended';
      await subscription.save();
      await Tenant.findByIdAndUpdate(tenant._id, { status: 'suspended' });
      clearTenantCache();
      suspendedCount += 1;

      await logAudit({
        actorType: 'superadmin',
        action: 'billing.subscription_suspended',
        entityType: 'Subscription',
        entityId: subscription._id,
        diff: { after: { status: 'suspended' } },
      });
    });
  }

  return { checked: tenants.length, suspendedCount };
}
