import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'account-required-salon';
const futureStart = () => new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

async function signUpCustomer(phone) {
  const res = await request(app).post(`/api/t/${slug}/account/auth/signup`).send({ phone, name: 'Test Customer', password: 'a-strong-password' });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Tenant.bookingRules.requireCustomerAccount', () => {
  let tenant;
  let ownerToken;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant, accessToken: ownerToken } = await createTenantWithOwner(app, {
      slug,
      displayName: 'Account Required Salon',
      allowAnonymousBooking: false, // this suite is specifically testing the real default/toggle behavior
    }));
    seed = await seedTenantData(tenant._id);
  });

  it('defaults to true, and reports it via GET /public/deposit-config', async () => {
    const res = await request(app).get(`/api/t/${slug}/public/deposit-config`);
    expect(res.status).toBe(200);
    expect(res.body.requireCustomerAccount).toBe(true);
  });

  it('blocks anonymous booking when true (the default)', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
        customerDetails: { phone: '0821234567', name: 'Anon Customer' },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_REQUIRED');
  });

  it('allows anonymous booking once the owner turns the setting off', async () => {
    const toggle = await request(app)
      .patch(`/api/t/${slug}/settings/booking-rules`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ requireCustomerAccount: false });
    expect(toggle.status).toBe(200);
    expect(toggle.body.requireCustomerAccount).toBe(false);

    const configRes = await request(app).get(`/api/t/${slug}/public/deposit-config`);
    expect(configRes.body.requireCustomerAccount).toBe(false);

    const res = await request(app)
      .post(`/api/t/${slug}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
        customerDetails: { phone: '0821234567', name: 'Anon Customer' },
      });
    expect(res.status).toBe(201);
  });

  it('lets a logged-in customer book via /account/appointments regardless of the setting', async () => {
    const { accessToken } = await signUpCustomer('0827654321');

    const res = await request(app)
      .post(`/api/t/${slug}/account/appointments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
      });
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBeTruthy();

    // Shows up in their own appointment list.
    const listRes = await request(app)
      .get(`/api/t/${slug}/account/appointments?status=upcoming`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body).toHaveLength(1);
  });

  it('rejects an unauthenticated call to /account/appointments', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/account/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
      });
    expect(res.status).toBe(401);
  });
});
