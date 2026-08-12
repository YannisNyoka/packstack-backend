import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { hashPassword } from '../../src/services/authService.js';
import { SuperAdminUser } from '../../src/models/SuperAdminUser.js';
import { Tenant } from '../../src/models/Tenant.js';

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

async function loginSuperAdmin() {
  const passwordHash = await hashPassword(SUPERADMIN_PASSWORD);
  await SuperAdminUser.create({ email: SUPERADMIN_EMAIL, passwordHash });
  const res = await request(app).post('/api/platform/auth/login').send({ email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD });
  return res.body.accessToken;
}

async function createPlan(overrides = {}) {
  const superAdminToken = await loginSuperAdmin();
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

function signupPayload(plan, overrides = {}) {
  return {
    slug: 'new-salon',
    displayName: 'New Salon',
    ownerEmail: 'owner@newsalon.example.com',
    ownerPassword: 'correct-horse-battery-staple',
    planId: plan._id,
    ...overrides,
  };
}

describe('POST /api/public/signup', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('provisions a tenant and owner, and returns a working access token', async () => {
    const plan = await createPlan();

    const res = await request(app).post('/api/public/signup').send(signupPayload(plan));
    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toBe('new-salon');
    expect(res.body.tenant.displayName).toBe('New Salon');
    expect(res.body.tenant.trialEndsAt).toBeTruthy();
    expect(res.body.accessToken).toEqual(expect.any(String));

    const tenant = await Tenant.findOne({ slug: 'new-salon' });
    expect(tenant.status).toBe('trial');

    const meRes = await request(app).get('/api/t/new-salon/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe('owner@newsalon.example.com');
    expect(meRes.body.role).toBe('owner');
  });

  it('rejects a duplicate subdomain', async () => {
    const plan = await createPlan();
    await request(app).post('/api/public/signup').send(signupPayload(plan));

    const res = await request(app).post('/api/public/signup').send(signupPayload(plan, { ownerEmail: 'other@example.com' }));
    expect(res.status).toBe(409);
  });

  it('rejects a password shorter than 12 characters', async () => {
    const plan = await createPlan();
    const res = await request(app).post('/api/public/signup').send(signupPayload(plan, { ownerPassword: 'tooshort' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown or inactive plan', async () => {
    const plan = await createPlan();
    const { Plan } = await import('../../src/models/Plan.js');
    await Plan.findByIdAndUpdate(plan._id, { active: false });

    const res = await request(app).post('/api/public/signup').send(signupPayload(plan));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid subdomain slug', async () => {
    const plan = await createPlan();
    const res = await request(app).post('/api/public/signup').send(signupPayload(plan, { slug: 'Not A Valid Slug!' }));
    expect(res.status).toBe(400);
  });
});
