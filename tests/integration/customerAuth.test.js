import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { Customer } from '../../src/models/Customer.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slugA = 'customer-auth-salon-a';
const slugB = 'customer-auth-salon-b';

describe('Customer account auth (/account/auth)', () => {
  let tenantA;
  let tenantB;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant: tenantA } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Customer Auth Salon A' }));
    ({ tenant: tenantB } = await createTenantWithOwner(app, { slug: slugB, displayName: 'Customer Auth Salon B' }));
  });

  it('signs up a brand-new phone number', async () => {
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234000',
      name: 'New Customer',
      email: 'new@example.com',
      password: 'a-strong-password',
    });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.customer).toMatchObject({ name: 'New Customer', phone: '+27821234000', email: 'new@example.com' });

    const stored = await runWithTenant(tenantA._id, async () => {
      return await Customer.findOne({ phone: '+27821234000' }).select('+passwordHash');
    });
    expect(stored.passwordHash).toEqual(expect.any(String));
  });

  it('claims an existing anonymous customer record, preserving loyaltyPoints and appointment history', async () => {
    const seed = await seedTenantData(tenantA._id);
    // seedTenantData creates an anonymous Customer at +27821234567 with no
    // passwordHash - simulate it already having history/points, then sign up
    // with the same phone.
    await runWithTenant(tenantA._id, async () => {
      await Customer.updateOne({ _id: seed.customer._id }, { loyaltyPoints: 120 });
    });

    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '+27821234567',
      name: 'Alice Client',
      password: 'a-strong-password',
    });
    expect(res.status).toBe(201);
    expect(res.body.customer.id).toBe(String(seed.customer._id));
    expect(res.body.customer.loyaltyPoints).toBe(120);
  });

  it('rejects signup for a phone that has already been claimed', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234001',
      name: 'First Signup',
      password: 'a-strong-password',
    });
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234001',
      name: 'Second Attempt',
      password: 'another-password',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234002',
      name: 'Weak Password',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('logs in with correct credentials and rejects wrong password', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234003',
      name: 'Login Test',
      password: 'a-strong-password',
    });

    const wrong = await request(app).post(`/api/t/${slugA}/account/auth/login`).send({ phone: '0821234003', password: 'wrong-password' });
    expect(wrong.status).toBe(401);

    const right = await request(app).post(`/api/t/${slugA}/account/auth/login`).send({ phone: '0821234003', password: 'a-strong-password' });
    expect(right.status).toBe(200);
    expect(right.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects login for a phone that has only ever booked anonymously (no account)', async () => {
    await seedTenantData(tenantA._id); // creates +27821234567 with no passwordHash
    const res = await request(app).post(`/api/t/${slugA}/account/auth/login`).send({ phone: '+27821234567', password: 'anything' });
    expect(res.status).toBe(401);
  });

  it('locks the account after 5 failed login attempts', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234004',
      name: 'Lockout Test',
      password: 'a-strong-password',
    });

    for (let i = 0; i < 5; i += 1) {
      await request(app).post(`/api/t/${slugA}/account/auth/login`).send({ phone: '0821234004', password: 'wrong' });
    }
    const res = await request(app).post(`/api/t/${slugA}/account/auth/login`).send({ phone: '0821234004', password: 'a-strong-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('refreshes an access token via the refresh cookie', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234005',
      name: 'Refresh Test',
      password: 'a-strong-password',
    });
    const cookie = signupRes.headers['set-cookie'].find((c) => c.startsWith('ps_customer_refresh='));
    expect(cookie).toBeDefined();

    const res = await request(app).post(`/api/t/${slugA}/account/auth/refresh`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('GET /me returns the logged-in customer', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234006',
      name: 'Me Test',
      password: 'a-strong-password',
    });
    const res = await request(app).get(`/api/t/${slugA}/account/auth/me`).set('Authorization', `Bearer ${signupRes.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Me Test', phone: '+27821234006' });
  });

  it('rejects a customer token from one tenant used against a different tenant', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234007',
      name: 'Cross Tenant',
      password: 'a-strong-password',
    });
    const res = await request(app).get(`/api/t/${slugB}/account/auth/me`).set('Authorization', `Bearer ${signupRes.body.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('logout-all revokes existing tokens', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234008',
      name: 'Logout All',
      password: 'a-strong-password',
    });
    const token = signupRes.body.accessToken;

    await request(app).post(`/api/t/${slugA}/account/auth/logout-all`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).get(`/api/t/${slugA}/account/auth/me`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('Anonymous public booking is unaffected by customer accounts', () => {
  let tenant;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Anon Regression Salon' }));
    seed = await seedTenantData(tenant._id);
  });

  it('still books without auth, and normalizes phone consistently for a later claim', async () => {
    const startTime = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const bookRes = await request(app)
      .post(`/api/t/${slugA}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime,
        customerDetails: { phone: '082 000 1111', name: 'Anon Booker' },
      });
    expect(bookRes.status).toBe(201);

    // Signing up with a differently-formatted version of the same number
    // should claim the same Customer doc, not create a duplicate.
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '+27820001111',
      name: 'Anon Booker',
      password: 'a-strong-password',
    });
    expect(signupRes.status).toBe(201);

    const history = await request(app)
      .get(`/api/t/${slugA}/account/appointments?status=upcoming`)
      .set('Authorization', `Bearer ${signupRes.body.accessToken}`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);

    // A repeat anonymous booking against the now-claimed phone must still
    // work with no auth and no 409 - claiming an account never blocks the
    // anonymous flow.
    const secondBookRes = await request(app)
      .post(`/api/t/${slugA}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
        customerDetails: { phone: '0820001111', name: 'Anon Booker' },
      });
    expect(secondBookRes.status).toBe(201);
  });
});
