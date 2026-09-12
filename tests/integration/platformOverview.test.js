import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { SuperAdminUser } from '../../src/models/SuperAdminUser.js';
import { hashPassword } from '../../src/services/authService.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Plan } from '../../src/models/Plan.js';
import { Subscription } from '../../src/models/Subscription.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(async () => {
  await clearDatabase();
});

async function superAdminToken() {
  const email = 'admin@packstack.co.za';
  const password = 'a-strong-superadmin-password';
  await SuperAdminUser.create({ email, passwordHash: await hashPassword(password) });
  const res = await request(app).post('/api/platform/auth/login').send({ email, password });
  return res.body.accessToken;
}

describe('GET /api/platform/overview', () => {
  it('rejects a request with no superadmin session', async () => {
    const res = await request(app).get('/api/platform/overview');
    expect(res.status).toBe(401);
  });

  it('counts tenants by status, MRR, and how many have ever actually been charged', async () => {
    const monthlyPlan = await Plan.create({
      key: 'standard',
      name: 'Standard',
      priceZAR: 99,
      billingInterval: 'monthly',
      limits: { maxStaff: 5, maxAppointmentsPerMonth: 500, whatsappMessagesPerMonth: 100, customDomainAllowed: false },
    });
    const annualPlan = await Plan.create({
      key: 'annual',
      name: 'Annual',
      priceZAR: 1200,
      billingInterval: 'annual',
      limits: { maxStaff: 5, maxAppointmentsPerMonth: 500, whatsappMessagesPerMonth: 100, customDomainAllowed: false },
    });

    // 1. Still on trial, no subscription at all.
    await createTenantWithOwner(app, { slug: 'trial-salon', displayName: 'Trial Salon' });

    // 2. Active, has been charged (currentPeriodEnd set), monthly plan - counts toward MRR.
    const activeTenant = (await createTenantWithOwner(app, { slug: 'active-salon', displayName: 'Active Salon' })).tenant;
    await Tenant.findByIdAndUpdate(activeTenant._id, { status: 'active' });
    await runWithTenant(activeTenant._id, () =>
      Subscription.create({ planId: monthlyPlan._id, status: 'active', currentPeriodEnd: new Date(Date.now() + 1000000) })
    );

    // 3. Past due, was charged before (currentPeriodEnd still set from the last real charge), annual plan.
    const pastDueTenant = (await createTenantWithOwner(app, { slug: 'pastdue-salon', displayName: 'Past Due Salon' })).tenant;
    await Tenant.findByIdAndUpdate(pastDueTenant._id, { status: 'past_due' });
    await runWithTenant(pastDueTenant._id, () =>
      Subscription.create({ planId: annualPlan._id, status: 'past_due', currentPeriodEnd: new Date(Date.now() - 1000) })
    );

    // 4. Suspended, never actually charged - only ever had the R0 trial authorization (currentPeriodEnd still null).
    const suspendedTenant = (await createTenantWithOwner(app, { slug: 'suspended-salon', displayName: 'Suspended Salon' })).tenant;
    await Tenant.findByIdAndUpdate(suspendedTenant._id, { status: 'suspended' });
    await runWithTenant(suspendedTenant._id, () =>
      Subscription.create({ planId: monthlyPlan._id, status: 'suspended', billingProviderSubscriptionToken: 'tok_abc', currentPeriodEnd: null })
    );

    const token = await superAdminToken();
    const res = await request(app).get('/api/platform/overview').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTenants).toBe(4);
    expect(res.body.byStatus).toEqual({ trial: 1, active: 1, past_due: 1, suspended: 1 });
    // Active + past_due tenants both have currentPeriodEnd set (charged before); trial never charged; suspended here never was.
    expect(res.body.everCharged).toBe(2);
    // MRR: monthly plan (99) + annual plan normalized to monthly (1200 / 12 = 100) = 199.
    expect(res.body.mrr).toBe(199);
  });

  it('returns zeroed metrics with no tenants at all', async () => {
    const token = await superAdminToken();
    const res = await request(app).get('/api/platform/overview').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTenants).toBe(0);
    expect(res.body.byStatus).toEqual({ trial: 0, active: 0, past_due: 0, suspended: 0 });
    expect(res.body.everCharged).toBe(0);
    expect(res.body.mrr).toBe(0);
    expect(res.body.signupsByMonth).toHaveLength(6);
  });

  it('buckets signups into the last 6 months, with the current month included', async () => {
    await createTenantWithOwner(app, { slug: 'this-month-salon', displayName: 'This Month Salon' });

    const token = await superAdminToken();
    const res = await request(app).get('/api/platform/overview').set('Authorization', `Bearer ${token}`);

    const currentMonthKey = new Date().toISOString().slice(0, 7);
    const currentBucket = res.body.signupsByMonth.find((b) => b.month === currentMonthKey);
    expect(currentBucket).toBeDefined();
    expect(currentBucket.count).toBe(1);
    const total = res.body.signupsByMonth.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
  });
});
