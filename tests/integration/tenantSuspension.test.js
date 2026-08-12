import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { Tenant } from '../../src/models/Tenant.js';
import { clearTenantCache } from '../../src/lib/tenantCache.js';

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

const slug = 'suspension-salon';

async function suspend(tenantId) {
  await Tenant.findByIdAndUpdate(tenantId, { status: 'suspended' });
  clearTenantCache();
}

describe('suspended tenant gating', () => {
  it('lets a suspended tenant still log in', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Suspension Salon' });
    await suspend(tenant._id);

    const res = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'owner@example.com', password: 'correct-horse-battery-staple' });
    expect(res.status).toBe(200);
    expect(res.body.user.tenantStatus).toBe('suspended');
  });

  it('lets a suspended tenant read the dashboard (GET) but blocks writes', async () => {
    const { tenant, accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Suspension Salon' });
    await suspend(tenant._id);

    const getRes = await request(app).get(`/api/t/${slug}/services`).set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.status).toBe(200);

    const postRes = await request(app)
      .post(`/api/t/${slug}/services`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Haircut', durationMinutes: 30, price: 100 });
    expect(postRes.status).toBe(403);
    expect(postRes.body.error.code).toBe('TENANT_READ_ONLY');
  });

  it('blocks the public booking surface entirely', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Suspension Salon' });
    await suspend(tenant._id);

    const res = await request(app).get(`/api/t/${slug}/public/services`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('still allows starting a billing checkout so the owner can reactivate', async () => {
    const { tenant, accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Suspension Salon' });
    await suspend(tenant._id);

    const plan = await request(app).post('/api/platform/plans').set('Authorization', `Bearer ${await superAdminToken()}`).send({
      key: 'starter',
      name: 'Starter',
      priceZAR: 499,
      billingInterval: 'monthly',
      limits: { maxStaff: 3, maxAppointmentsPerMonth: 200, whatsappMessagesPerMonth: 500, customDomainAllowed: false },
    });

    const res = await request(app)
      .post(`/api/t/${slug}/billing/checkout`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ planId: plan.body._id });
    expect(res.status).toBe(201);
  });

  it('does not restrict anything for a past_due tenant (banner-only per architecture doc)', async () => {
    const { tenant, accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Suspension Salon' });
    await Tenant.findByIdAndUpdate(tenant._id, { status: 'past_due' });
    clearTenantCache();

    const postRes = await request(app)
      .post(`/api/t/${slug}/services`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Haircut', durationMinutes: 30, price: 100 });
    expect(postRes.status).toBe(201);

    const publicRes = await request(app).get(`/api/t/${slug}/public/services`);
    expect(publicRes.status).toBe(200);
  });
});

async function superAdminToken() {
  const { SuperAdminUser } = await import('../../src/models/SuperAdminUser.js');
  const { hashPassword } = await import('../../src/services/authService.js');
  const email = 'admin@packstack.co.za';
  const password = 'a-strong-superadmin-password';
  await SuperAdminUser.deleteOne({ email });
  await SuperAdminUser.create({ email, passwordHash: await hashPassword(password) });
  const res = await request(app).post('/api/platform/auth/login').send({ email, password });
  return res.body.accessToken;
}
