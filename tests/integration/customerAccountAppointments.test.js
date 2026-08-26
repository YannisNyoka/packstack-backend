import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
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

const slug = 'customer-account-appts-salon';
const futureStart = (daysAhead) => new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);

const emailFor = (phone) => `${phone.replace(/\D/g, '')}@example.com`;

async function signUpCustomer({ phone, name }) {
  const res = await request(app)
    .post(`/api/t/${slug}/account/auth/signup`)
    .send({ phone, name, email: emailFor(phone), password: 'a-strong-password' });
  expect(res.status).toBe(201);
  return res.body;
}

async function bookAsCustomer({ seed, phone, token, startTime }) {
  // Book anonymously with the given phone (the account already exists for
  // that phone, so this appointment attaches to the same Customer._id), then
  // confirm the logged-in customer can see it.
  const res = await request(app)
    .post(`/api/t/${slug}/public/appointments`)
    .send({
      staffMemberId: String(seed.staff._id),
      serviceIds: [String(seed.service._id)],
      startTime: startTime.toISOString(),
      customerDetails: { phone, name: 'irrelevant' },
    });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Customer self-service appointments (/account/appointments)', () => {
  let tenant;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant } = await createTenantWithOwner(app, { slug, displayName: 'Customer Account Appts Salon' }));
    seed = await seedTenantData(tenant._id);
  });

  it('lists only the logged-in customer\'s own upcoming appointments', async () => {
    const me = await signUpCustomer({ phone: '0821111001', name: 'Owner Of Booking' });
    const other = await signUpCustomer({ phone: '0821111002', name: 'Someone Else' });

    await bookAsCustomer({ seed, phone: '0821111001', startTime: futureStart(10) });
    await bookAsCustomer({ seed, phone: '0821111002', startTime: futureStart(11) });

    const res = await request(app)
      .get(`/api/t/${slug}/account/appointments?status=upcoming`)
      .set('Authorization', `Bearer ${me.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].customerId).toBeTruthy();

    const otherRes = await request(app)
      .get(`/api/t/${slug}/account/appointments?status=upcoming`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(otherRes.body).toHaveLength(1);
  });

  it('reschedules its own appointment when outside the reschedule window', async () => {
    const me = await signUpCustomer({ phone: '0821111003', name: 'Reschedule Self' });
    const appointment = await bookAsCustomer({ seed, phone: '0821111003', startTime: futureStart(10) });

    const res = await request(app)
      .patch(`/api/t/${slug}/account/appointments/${appointment._id}/reschedule`)
      .set('Authorization', `Bearer ${me.accessToken}`)
      .send({ newStartTime: futureStart(11).toISOString() });
    expect(res.status).toBe(200);
  });

  it('rejects a reschedule inside the tenant reschedule window (booking rules still enforced)', async () => {
    const me = await signUpCustomer({ phone: '0821111004', name: 'Window Test' });
    const appointment = await bookAsCustomer({ seed, phone: '0821111004', startTime: futureStart(1) }); // inside default 36h window

    const res = await request(app)
      .patch(`/api/t/${slug}/account/appointments/${appointment._id}/reschedule`)
      .set('Authorization', `Bearer ${me.accessToken}`)
      .send({ newStartTime: futureStart(2).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESCHEDULE_WINDOW');
  });

  it('cancels its own appointment', async () => {
    const me = await signUpCustomer({ phone: '0821111005', name: 'Cancel Self' });
    const appointment = await bookAsCustomer({ seed, phone: '0821111005', startTime: futureStart(10) });

    const res = await request(app)
      .patch(`/api/t/${slug}/account/appointments/${appointment._id}/cancel`)
      .set('Authorization', `Bearer ${me.accessToken}`)
      .send({ reason: 'change of plans' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('403s when a customer tries to reschedule someone else\'s appointment', async () => {
    await signUpCustomer({ phone: '0821111006', name: 'Owner' });
    const intruder = await signUpCustomer({ phone: '0821111007', name: 'Intruder' });
    const appointment = await bookAsCustomer({ seed, phone: '0821111006', startTime: futureStart(10) });

    const res = await request(app)
      .patch(`/api/t/${slug}/account/appointments/${appointment._id}/reschedule`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({ newStartTime: futureStart(11).toISOString() });
    expect(res.status).toBe(403);
  });

  it('403s when a customer tries to cancel someone else\'s appointment', async () => {
    await signUpCustomer({ phone: '0821111008', name: 'Owner' });
    const intruder = await signUpCustomer({ phone: '0821111009', name: 'Intruder' });
    const appointment = await bookAsCustomer({ seed, phone: '0821111008', startTime: futureStart(10) });

    const res = await request(app)
      .patch(`/api/t/${slug}/account/appointments/${appointment._id}/cancel`)
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('blocks customer login/self-service entirely when the tenant is suspended', async () => {
    const me = await signUpCustomer({ phone: '0821111010', name: 'Suspended Test' });

    await Tenant.findByIdAndUpdate(tenant._id, { status: 'suspended' });
    clearTenantCache();

    const loginRes = await request(app)
      .post(`/api/t/${slug}/account/auth/login`)
      .send({ email: emailFor('0821111010'), password: 'a-strong-password' });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error.code).toBe('TENANT_SUSPENDED');

    const listRes = await request(app)
      .get(`/api/t/${slug}/account/appointments?status=upcoming`)
      .set('Authorization', `Bearer ${me.accessToken}`);
    expect(listRes.status).toBe(403);
    expect(listRes.body.error.code).toBe('TENANT_SUSPENDED');
  });
});
