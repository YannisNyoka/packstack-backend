import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { Customer } from '../../src/models/Customer.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { verifyCustomerPasswordResetToken } from '../../src/lib/jwt.js';

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

  it('signs up a brand-new phone number, logging in by email', async () => {
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
      email: 'alice@example.com',
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
      email: 'first@example.com',
      password: 'a-strong-password',
    });
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234001',
      name: 'Second Attempt',
      email: 'second@example.com',
      password: 'another-password',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('rejects signup for an email that already has an account, even with a different phone', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234011',
      name: 'First Signup',
      email: 'shared@example.com',
      password: 'a-strong-password',
    });
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234012',
      name: 'Second Attempt',
      email: 'shared@example.com',
      password: 'another-password',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('rejects signup missing an email', async () => {
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234013',
      name: 'No Email',
      password: 'a-strong-password',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234002',
      name: 'Weak Password',
      email: 'weak@example.com',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('logs in with correct credentials and rejects wrong password', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234003',
      name: 'Login Test',
      email: 'logintest@example.com',
      password: 'a-strong-password',
    });

    const wrong = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'logintest@example.com', password: 'wrong-password' });
    expect(wrong.status).toBe(401);

    const right = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'logintest@example.com', password: 'a-strong-password' });
    expect(right.status).toBe(200);
    expect(right.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects login for an email that has no account', async () => {
    await seedTenantData(tenantA._id); // creates +27821234567 with no passwordHash, no email
    const res = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'nobody@example.com', password: 'anything' });
    expect(res.status).toBe(401);
  });

  it('locks the account after 5 failed login attempts', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234004',
      name: 'Lockout Test',
      email: 'lockout@example.com',
      password: 'a-strong-password',
    });

    for (let i = 0; i < 5; i += 1) {
      await request(app).post(`/api/t/${slugA}/account/auth/login`).send({ email: 'lockout@example.com', password: 'wrong' });
    }
    const res = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'lockout@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('refreshes an access token via the refresh cookie', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234005',
      name: 'Refresh Test',
      email: 'refresh@example.com',
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
      email: 'metest@example.com',
      password: 'a-strong-password',
    });
    const res = await request(app).get(`/api/t/${slugA}/account/auth/me`).set('Authorization', `Bearer ${signupRes.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Me Test', phone: '+27821234006', email: 'metest@example.com' });
  });

  it('rejects a customer token from one tenant used against a different tenant', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821234007',
      name: 'Cross Tenant',
      email: 'crosstenant@example.com',
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
      email: 'logoutall@example.com',
      password: 'a-strong-password',
    });
    const token = signupRes.body.accessToken;

    await request(app).post(`/api/t/${slugA}/account/auth/logout-all`).set('Authorization', `Bearer ${token}`);

    const res = await request(app).get(`/api/t/${slugA}/account/auth/me`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('Customer self-service profile (/account/profile)', () => {
  let tenantA;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant: tenantA } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Customer Auth Salon A' }));
  });

  it('rejects clearing email to empty, since it is the login identifier', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821239100',
      name: 'Profile Test',
      email: 'profiletest@example.com',
      password: 'a-strong-password',
    });
    const res = await request(app)
      .patch(`/api/t/${slugA}/account/profile`)
      .set('Authorization', `Bearer ${signupRes.body.accessToken}`)
      .send({ email: '' });
    expect(res.status).toBe(400);
  });

  it('rejects changing email to one already used by another account', async () => {
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821239101',
      name: 'First',
      email: 'first-profile@example.com',
      password: 'a-strong-password',
    });
    const secondSignup = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821239102',
      name: 'Second',
      email: 'second-profile@example.com',
      password: 'a-strong-password',
    });

    const res = await request(app)
      .patch(`/api/t/${slugA}/account/profile`)
      .set('Authorization', `Bearer ${secondSignup.body.accessToken}`)
      .send({ email: 'first-profile@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('allows changing to a genuinely unused email', async () => {
    const signupRes = await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821239103',
      name: 'Changer',
      email: 'old-email@example.com',
      password: 'a-strong-password',
    });
    const res = await request(app)
      .patch(`/api/t/${slugA}/account/profile`)
      .set('Authorization', `Bearer ${signupRes.body.accessToken}`)
      .send({ email: 'new-email@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('new-email@example.com');

    const loginRes = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'new-email@example.com', password: 'a-strong-password' });
    expect(loginRes.status).toBe(200);
  });
});

describe('Customer password reset (/account/auth/forgot-password, /reset-password)', () => {
  let tenantA;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant: tenantA } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Customer Auth Salon A' }));
    await request(app).post(`/api/t/${slugA}/account/auth/signup`).send({
      phone: '0821239000',
      name: 'Reset Me',
      email: 'resetme@example.com',
      password: 'original-password',
    });
  });

  it('always returns a generic response, whether or not the email has an account', async () => {
    const known = await request(app).post(`/api/t/${slugA}/account/auth/forgot-password`).send({ email: 'resetme@example.com' });
    const unknown = await request(app).post(`/api/t/${slugA}/account/auth/forgot-password`).send({ email: 'nobody@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it('resets the password with a valid token and logs the customer in', async () => {
    const { Customer: CustomerModel } = await import('../../src/models/Customer.js');
    const { signCustomerPasswordResetToken } = await import('../../src/lib/jwt.js');

    const customer = await runWithTenant(tenantA._id, async () => CustomerModel.findOne({ email: 'resetme@example.com' }));
    const token = signCustomerPasswordResetToken({ customerId: customer._id, tenantId: tenantA._id, tokenVersion: customer.tokenVersion });

    const res = await request(app)
      .post(`/api/t/${slugA}/account/auth/reset-password`)
      .send({ token, password: 'brand-new-password' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const loginOld = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'resetme@example.com', password: 'original-password' });
    expect(loginOld.status).toBe(401);

    const loginNew = await request(app)
      .post(`/api/t/${slugA}/account/auth/login`)
      .send({ email: 'resetme@example.com', password: 'brand-new-password' });
    expect(loginNew.status).toBe(200);
  });

  it('rejects a reset token reused a second time (tokenVersion bumped on first use)', async () => {
    const { Customer: CustomerModel } = await import('../../src/models/Customer.js');
    const { signCustomerPasswordResetToken } = await import('../../src/lib/jwt.js');

    const customer = await runWithTenant(tenantA._id, async () => CustomerModel.findOne({ email: 'resetme@example.com' }));
    const token = signCustomerPasswordResetToken({ customerId: customer._id, tenantId: tenantA._id, tokenVersion: customer.tokenVersion });

    const first = await request(app).post(`/api/t/${slugA}/account/auth/reset-password`).send({ token, password: 'first-new-password' });
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/t/${slugA}/account/auth/reset-password`).send({ token, password: 'second-new-password' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('rejects a reset token minted for a different tenant', async () => {
    const { tenant: tenantB } = await createTenantWithOwner(app, { slug: slugB, displayName: 'Salon B' });
    const { Customer: CustomerModel } = await import('../../src/models/Customer.js');
    const { signCustomerPasswordResetToken } = await import('../../src/lib/jwt.js');

    const customer = await runWithTenant(tenantA._id, async () => CustomerModel.findOne({ email: 'resetme@example.com' }));
    const token = signCustomerPasswordResetToken({ customerId: customer._id, tenantId: tenantB._id, tokenVersion: customer.tokenVersion });

    const res = await request(app).post(`/api/t/${slugA}/account/auth/reset-password`).send({ token, password: 'wont-work' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app)
      .post(`/api/t/${slugA}/account/auth/reset-password`)
      .send({ token: 'not-a-real-token', password: 'wont-work-either' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('verifyCustomerPasswordResetToken rejects a token signed with the wrong audience (sanity check on token family separation)', async () => {
    const { signCustomerAccessToken } = await import('../../src/lib/jwt.js');
    const accessToken = signCustomerAccessToken({ customerId: 'x', tenantId: 'y', tokenVersion: 0 });
    expect(() => verifyCustomerPasswordResetToken(accessToken)).toThrow();
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
      email: 'anonbooker@example.com',
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
