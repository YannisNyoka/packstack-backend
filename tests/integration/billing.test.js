import request from 'supertest';
import { DateTime } from 'luxon';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { SuperAdminUser } from '../../src/models/SuperAdminUser.js';
import { Subscription } from '../../src/models/Subscription.js';
import { Plan } from '../../src/models/Plan.js';
import { Tenant } from '../../src/models/Tenant.js';
import { hashPassword } from '../../src/services/authService.js';
import { buildSignature } from '../../src/lib/providers/payfastClient.js';
import { expirePastDueSubscriptions } from '../../src/services/billingService.js';
import { env } from '../../src/config/env.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const SUPERADMIN_EMAIL = 'admin@packstack.co.za';
const SUPERADMIN_PASSWORD = 'a-strong-superadmin-password';
const slug = 'billing-salon';

async function loginSuperAdmin() {
  const passwordHash = await hashPassword(SUPERADMIN_PASSWORD);
  await SuperAdminUser.create({ email: SUPERADMIN_EMAIL, passwordHash });
  const res = await request(app).post('/api/platform/auth/login').send({ email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD });
  return res.body.accessToken;
}

async function createPlan(superAdminToken, overrides = {}) {
  const res = await request(app)
    .post('/api/platform/plans')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({
      key: 'starter',
      name: 'Starter',
      priceZAR: 499,
      billingInterval: 'monthly',
      limits: { maxStaff: 3, maxAppointmentsPerMonth: 200, whatsappMessagesPerMonth: 500, customDomainAllowed: false },
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body;
}

/** Builds a raw application/x-www-form-urlencoded ITN body with a valid signature. */
function buildItnBody(fields) {
  const ordered = Object.entries(fields);
  const signature = buildSignature(ordered, env.PAYFAST_PASSPHRASE);
  return [...ordered, ['signature', signature]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

describe('PayFast subscription billing', () => {
  let tenant;
  let ownerToken;
  let superAdminToken;
  let plan;

  beforeEach(async () => {
    await clearDatabase();
    superAdminToken = await loginSuperAdmin();
    plan = await createPlan(superAdminToken);
    ({ tenant, accessToken: ownerToken } = await createTenantWithOwner(app, { slug, displayName: 'Billing Salon' }));
  });

  describe('checkout', () => {
    it('defers billing to trial end for a fresh signup, capturing the card with a R0 authorization', async () => {
      const res = await request(app)
        .post(`/api/t/${slug}/billing/checkout`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ planId: plan._id });

      expect(res.status).toBe(201);
      expect(res.body.checkoutUrl).toBe('https://sandbox.payfast.co.za/eng/process');
      expect(res.body.fields.merchant_id).toBe('10000100');
      expect(res.body.fields.custom_str1).toBe(String(tenant._id));
      expect(res.body.fields.amount).toBe('0.00');
      expect(res.body.fields.recurring_amount).toBe('499.00');
      expect(res.body.fields.billing_date).toBe(DateTime.fromJSDate(tenant.trialEndsAt).toFormat('yyyy-LL-dd'));
      expect(res.body.fields.signature).toEqual(expect.any(String));

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('trialing');
      expect(String(subscription.planId)).toBe(String(plan._id));
      expect(res.body.fields.m_payment_id).toBe(String(subscription._id));
    });

    it('charges immediately once the trial has already ended', async () => {
      await Tenant.findByIdAndUpdate(tenant._id, { trialEndsAt: DateTime.now().minus({ days: 1 }).toJSDate() });

      const res = await request(app)
        .post(`/api/t/${slug}/billing/checkout`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ planId: plan._id });

      expect(res.status).toBe(201);
      expect(res.body.fields.amount).toBe('499.00');
      expect(res.body.fields.billing_date).toBeUndefined();
    });

    it('rejects staff from creating a checkout', async () => {
      const passwordHash = await hashPassword('staff-password-123');
      await runWithTenant(tenant._id, async () => {
        const { User } = await import('../../src/models/User.js');
        await User.create({ email: 'staff@example.com', passwordHash, role: 'staff' });
      });
      const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'staff@example.com', password: 'staff-password-123' });

      const res = await request(app)
        .post(`/api/t/${slug}/billing/checkout`)
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .send({ planId: plan._id });
      expect(res.status).toBe(403);
    });

    it('rejects an unknown or inactive plan', async () => {
      const res = await request(app)
        .post(`/api/t/${slug}/billing/checkout`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ planId: '64b000000000000000000000' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /billing/plans', () => {
    it('lets the tenant owner list active plans (no superadmin session required)', async () => {
      const res = await request(app).get(`/api/t/${slug}/billing/plans`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].key).toBe('starter');
    });

    it('excludes inactive plans', async () => {
      await Plan.findByIdAndUpdate(plan._id, { active: false });
      const res = await request(app).get(`/api/t/${slug}/billing/plans`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('rejects staff', async () => {
      const passwordHash = await hashPassword('staff-password-123');
      await runWithTenant(tenant._id, async () => {
        const { User } = await import('../../src/models/User.js');
        await User.create({ email: 'staff-plans@example.com', passwordHash, role: 'staff' });
      });
      const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'staff-plans@example.com', password: 'staff-password-123' });

      const res = await request(app).get(`/api/t/${slug}/billing/plans`).set('Authorization', `Bearer ${loginRes.body.accessToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /billing/subscription', () => {
    it('returns the tenant subscription with its plan populated', async () => {
      await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });

      const res = await request(app).get(`/api/t/${slug}/billing/subscription`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('trialing');
      expect(res.body.planId.key).toBe('starter');
    });
  });

  describe('POST /api/platform/billing/payfast/itn', () => {
    async function checkout() {
      const res = await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });
      return res.body;
    }

    it('activates the subscription on a valid COMPLETE ITN with a real debit (the trial-end auto-charge)', async () => {
      const { fields } = await checkout();
      const body = buildItnBody({
        custom_str1: fields.custom_str1,
        m_payment_id: fields.m_payment_id,
        pf_payment_id: 'pf-12345',
        payment_status: 'COMPLETE',
        amount_gross: '499.00',
        token: 'pf-subscription-token-abc',
      });

      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(200);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('active');
      expect(subscription.billingProviderCustomerId).toBe('pf-12345');
      expect(subscription.billingProviderSubscriptionToken).toBe('pf-subscription-token-abc');
      expect(subscription.currentPeriodEnd).toBeInstanceOf(Date);
      expect(subscription.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

      const updatedTenant = await Tenant.findById(tenant._id);
      expect(updatedTenant.status).toBe('active');
    });

    it('captures the token but does not activate on the R0 trial-authorization ITN', async () => {
      const { fields } = await checkout();
      const body = buildItnBody({
        custom_str1: fields.custom_str1,
        m_payment_id: fields.m_payment_id,
        payment_status: 'COMPLETE',
        amount_gross: '0.00',
        token: 'pf-subscription-token-abc',
      });

      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(200);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('trialing');
      expect(subscription.billingProviderSubscriptionToken).toBe('pf-subscription-token-abc');

      const updatedTenant = await Tenant.findById(tenant._id);
      expect(updatedTenant.status).toBe('trial');
    });

    it('suspends a trialing subscription outright when its deferred trial-end debit fails', async () => {
      const { fields } = await checkout();
      const body = buildItnBody({ custom_str1: fields.custom_str1, m_payment_id: fields.m_payment_id, payment_status: 'FAILED' });

      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(200);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('suspended');

      const updatedTenant = await Tenant.findById(tenant._id);
      expect(updatedTenant.status).toBe('suspended');
    });

    it('rejects an ITN with a tampered field (invalid signature)', async () => {
      const { fields } = await checkout();
      const ordered = [
        ['custom_str1', fields.custom_str1],
        ['m_payment_id', fields.m_payment_id],
        ['payment_status', 'COMPLETE'],
      ];
      const signature = buildSignature(ordered, env.PAYFAST_PASSPHRASE);
      // Tamper payment_status after signing - signature won't match anymore.
      const body = ordered
        .map(([k, v], i) => (i === 2 ? `${k}=FAILED` : `${k}=${encodeURIComponent(v)}`))
        .concat(`signature=${signature}`)
        .join('&');

      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(403);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('trialing'); // untouched
    });

    it('rejects an ITN missing custom_str1', async () => {
      const { fields } = await checkout();
      const body = buildItnBody({ m_payment_id: fields.m_payment_id, payment_status: 'COMPLETE' });
      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(400);
    });

    it('404s for an ITN naming a tenant that does not exist', async () => {
      const body = buildItnBody({ custom_str1: '64b000000000000000000000', m_payment_id: 'irrelevant', payment_status: 'COMPLETE' });
      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(404);
    });

    it("404s when m_payment_id doesn't match the tenant's subscription", async () => {
      const { fields } = await checkout();
      const body = buildItnBody({ custom_str1: fields.custom_str1, m_payment_id: 'not-the-real-subscription-id', payment_status: 'COMPLETE' });
      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(404);
    });

    it('moves an active subscription to past_due with a grace period on a FAILED ITN', async () => {
      const { fields } = await checkout();
      const activate = buildItnBody({
        custom_str1: fields.custom_str1,
        m_payment_id: fields.m_payment_id,
        payment_status: 'COMPLETE',
        amount_gross: '499.00',
      });
      await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(activate);

      const fail = buildItnBody({ custom_str1: fields.custom_str1, m_payment_id: fields.m_payment_id, payment_status: 'FAILED' });
      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(fail);
      expect(res.status).toBe(200);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('past_due');
      expect(subscription.gracePeriodEndsAt).toBeInstanceOf(Date);
      expect(subscription.gracePeriodEndsAt.getTime()).toBeGreaterThan(Date.now());

      const updatedTenant = await Tenant.findById(tenant._id);
      expect(updatedTenant.status).toBe('past_due');
    });

    it('leaves a trialing subscription alone on a PENDING ITN', async () => {
      const { fields } = await checkout();
      const body = buildItnBody({ custom_str1: fields.custom_str1, m_payment_id: fields.m_payment_id, payment_status: 'PENDING' });
      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(200);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('trialing');
    });

    it('ignores a redelivered ITN with the same pf_payment_id instead of reapplying it', async () => {
      const { fields } = await checkout();
      const body = buildItnBody({
        custom_str1: fields.custom_str1,
        m_payment_id: fields.m_payment_id,
        pf_payment_id: 'pf-redelivered-1',
        payment_status: 'COMPLETE',
        amount_gross: '499.00',
        token: 'pf-subscription-token-abc',
      });

      const first = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(first.status).toBe(200);
      const afterFirst = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      const firstPeriodEnd = afterFirst.currentPeriodEnd.getTime();

      // PayFast redelivers the exact same notification (their documented
      // retry behavior) - must be a clean no-op, not a second period extension.
      const second = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(second.status).toBe(200);

      const afterSecond = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(afterSecond.currentPeriodEnd.getTime()).toBe(firstPeriodEnd);
    });

    it('self-heals planId when the ITN amount matches a different active plan than the one currently on the subscription', async () => {
      const proPlan = await createPlan(superAdminToken, { key: 'pro', priceZAR: 999 });
      const { fields } = await checkout(); // checked out for `plan` (starter, 499)

      // Simulate the plan-switch race the reconciliation exists for: a
      // second checkout attempt (sharing the same m_payment_id) reassigned
      // planId to Pro before this ITN, for the original Starter checkout, arrives.
      await runWithTenant(tenant._id, async () => {
        const subscription = await Subscription.findOne({});
        subscription.planId = proPlan._id;
        await subscription.save();
      });

      const body = buildItnBody({
        custom_str1: fields.custom_str1,
        m_payment_id: fields.m_payment_id,
        pf_payment_id: 'pf-mismatch-1',
        payment_status: 'COMPLETE',
        amount_gross: '499.00', // what was actually charged: Starter's price
        token: 'pf-subscription-token-abc',
      });
      const res = await request(app).post('/api/platform/billing/payfast/itn').set('Content-Type', 'application/x-www-form-urlencoded').send(body);
      expect(res.status).toBe(200);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}).populate('planId'));
      expect(subscription.status).toBe('active');
      expect(subscription.planId.key).toBe('starter'); // corrected back to what was actually paid for
    });
  });

  describe('POST /billing/cancel', () => {
    it('cancels a subscription that has a PayFast token', async () => {
      await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });
      await runWithTenant(tenant._id, async () => {
        const subscription = await Subscription.findOne({});
        subscription.billingProviderSubscriptionToken = 'pf-subscription-token-abc';
        await subscription.save();
      });

      const res = await request(app).post(`/api/t/${slug}/billing/cancel`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('canceled');
      expect(res.body.cancelAtPeriodEnd).toBe(true);

      const updatedTenant = await Tenant.findById(tenant._id);
      expect(updatedTenant.status).toBe('trial'); // access continues for the rest of the trial
    });

    it('rejects cancelling a subscription with no PayFast token yet', async () => {
      await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });

      const res = await request(app).post(`/api/t/${slug}/billing/cancel`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
    });

    it('rejects staff from cancelling', async () => {
      const passwordHash = await hashPassword('staff-password-123');
      await runWithTenant(tenant._id, async () => {
        const { User } = await import('../../src/models/User.js');
        await User.create({ email: 'staff-cancel@example.com', passwordHash, role: 'staff' });
      });
      const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'staff-cancel@example.com', password: 'staff-password-123' });

      const res = await request(app).post(`/api/t/${slug}/billing/cancel`).set('Authorization', `Bearer ${loginRes.body.accessToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('expirePastDueSubscriptions sweep', () => {
    // tryCancelPayfastSubscription() skips the real PayFast call under
    // NODE_ENV=test (same convention as POST /billing/cancel's own tests
    // above) - this only exercises that the sweep still completes cleanly
    // with a token present, not the network call itself.
    it('suspends a past_due subscription with a PayFast token on file', async () => {
      await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });

      await runWithTenant(tenant._id, async () => {
        const subscription = await Subscription.findOne({});
        subscription.status = 'past_due';
        subscription.gracePeriodEndsAt = new Date(Date.now() - 1000); // already expired
        subscription.billingProviderSubscriptionToken = 'pf-subscription-token-abc';
        await subscription.save();
      });

      const result = await expirePastDueSubscriptions();
      expect(result.suspendedCount).toBe(1);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('suspended');
    });

    it('suspends only past_due subscriptions whose grace period has expired', async () => {
      await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });

      await runWithTenant(tenant._id, async () => {
        const subscription = await Subscription.findOne({});
        subscription.status = 'past_due';
        subscription.gracePeriodEndsAt = new Date(Date.now() - 1000); // already expired
        await subscription.save();
      });

      const result = await expirePastDueSubscriptions();
      expect(result.suspendedCount).toBe(1);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('suspended');

      const updatedTenant = await Tenant.findById(tenant._id);
      expect(updatedTenant.status).toBe('suspended');
    });

    it('leaves a past_due subscription alone while its grace period is still running', async () => {
      await request(app).post(`/api/t/${slug}/billing/checkout`).set('Authorization', `Bearer ${ownerToken}`).send({ planId: plan._id });

      await runWithTenant(tenant._id, async () => {
        const subscription = await Subscription.findOne({});
        subscription.status = 'past_due';
        subscription.gracePeriodEndsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        await subscription.save();
      });

      const result = await expirePastDueSubscriptions();
      expect(result.suspendedCount).toBe(0);

      const subscription = await runWithTenant(tenant._id, async () => await Subscription.findOne({}));
      expect(subscription.status).toBe('past_due');
    });
  });
});
