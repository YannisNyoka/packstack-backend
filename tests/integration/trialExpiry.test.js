import request from 'supertest';
import { DateTime } from 'luxon';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { Tenant } from '../../src/models/Tenant.js';
import { expireTrials } from '../../src/services/billingService.js';
import { TRIAL_LENGTH_DAYS } from '../../src/services/platformService.js';

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

const slug = 'trial-salon';

describe('trial provisioning', () => {
  it('sets trialEndsAt roughly TRIAL_LENGTH_DAYS out at provisioning', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });

    expect(tenant.trialEndsAt).not.toBeNull();
    const daysOut = DateTime.fromJSDate(tenant.trialEndsAt).diff(DateTime.now(), 'days').days;
    expect(daysOut).toBeGreaterThan(TRIAL_LENGTH_DAYS - 1);
    expect(daysOut).toBeLessThanOrEqual(TRIAL_LENGTH_DAYS);
  });

  it('returns trialEndsAt from login and /auth/me', async () => {
    const { accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });

    const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'owner@example.com', password: 'correct-horse-battery-staple' });
    expect(loginRes.body.user.trialEndsAt).toBeTruthy();

    const meRes = await request(app).get(`/api/t/${slug}/auth/me`).set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.body.trialEndsAt).toBeTruthy();
  });
});

describe('billingService.expireTrials', () => {
  it('suspends a trial tenant whose trialEndsAt passed more than 24h ago', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });
    await Tenant.findByIdAndUpdate(tenant._id, { trialEndsAt: DateTime.now().minus({ days: 2 }).toJSDate() });

    const result = await expireTrials();

    expect(result.suspendedCount).toBe(1);
    const updated = await Tenant.findById(tenant._id);
    expect(updated.status).toBe('suspended');
  });

  it('leaves a trial tenant alone within the 24h buffer after trialEndsAt (gives the deferred debit ITN time to land)', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });
    await Tenant.findByIdAndUpdate(tenant._id, { trialEndsAt: DateTime.now().minus({ hours: 12 }).toJSDate() });

    const result = await expireTrials();

    expect(result.suspendedCount).toBe(0);
    const updated = await Tenant.findById(tenant._id);
    expect(updated.status).toBe('trial');
  });

  it('leaves a trial tenant alone if trialEndsAt has not passed yet', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });
    // Default trialEndsAt from provisioning is ~30 days out already, but be explicit.
    await Tenant.findByIdAndUpdate(tenant._id, { trialEndsAt: DateTime.now().plus({ days: 5 }).toJSDate() });

    const result = await expireTrials();

    expect(result.suspendedCount).toBe(0);
    const updated = await Tenant.findById(tenant._id);
    expect(updated.status).toBe('trial');
  });

  it('leaves a tenant with no trialEndsAt alone (grandfathered, predates the field)', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });
    await Tenant.findByIdAndUpdate(tenant._id, { trialEndsAt: null });

    const result = await expireTrials();

    expect(result.suspendedCount).toBe(0);
    const updated = await Tenant.findById(tenant._id);
    expect(updated.status).toBe('trial');
  });

  it('does not touch a tenant that already became active, even with a past trialEndsAt', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });
    await Tenant.findByIdAndUpdate(tenant._id, {
      status: 'active',
      trialEndsAt: DateTime.now().minus({ days: 1 }).toJSDate(),
    });

    const result = await expireTrials();

    expect(result.suspendedCount).toBe(0);
    const updated = await Tenant.findById(tenant._id);
    expect(updated.status).toBe('active');
  });

  it('a tenant suspended by trial expiry is gated exactly like any other suspended tenant', async () => {
    const { tenant, accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Trial Salon' });
    await Tenant.findByIdAndUpdate(tenant._id, { trialEndsAt: DateTime.now().minus({ days: 2 }).toJSDate() });
    await expireTrials();

    const publicRes = await request(app).get(`/api/t/${slug}/public/services`);
    expect(publicRes.status).toBe(403);
    expect(publicRes.body.error.code).toBe('TENANT_SUSPENDED');

    const writeRes = await request(app)
      .post(`/api/t/${slug}/services`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Haircut', durationMinutes: 30, price: 100 });
    expect(writeRes.status).toBe(403);
    expect(writeRes.body.error.code).toBe('TENANT_READ_ONLY');
  });
});
