import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { earnPointsForCompletedAppointment } from '../../src/services/loyaltyService.js';
import { Appointment } from '../../src/models/Appointment.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'customer-loyalty-salon';

describe('Customer self-service loyalty (/account/loyalty)', () => {
  let tenant;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant } = await createTenantWithOwner(app, { slug, displayName: 'Customer Loyalty Salon' }));
    seed = await seedTenantData(tenant._id);
  });

  it('returns balance and history for the logged-in customer only', async () => {
    const signupRes = await request(app).post(`/api/t/${slug}/account/auth/signup`).send({
      phone: '+27821234567', // matches seedTenantData's Customer
      name: 'Alice Client',
      password: 'a-strong-password',
    });
    expect(signupRes.status).toBe(201);

    await runWithTenant(tenant._id, async () => {
      const appointment = await Appointment.create({
        customerId: seed.customer._id,
        staffMemberId: seed.staff._id,
        serviceIds: [seed.service._id],
        startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
        endTime: new Date(),
        priceSnapshot: 350,
        status: 'completed',
      });
      await earnPointsForCompletedAppointment({ appointment });
    });

    const res = await request(app).get(`/api/t/${slug}/account/loyalty`).set('Authorization', `Bearer ${signupRes.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(35); // 1 point per R10 spent on a R350 service
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ pointsDelta: 35, reason: 'earned_booking' });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/t/${slug}/account/loyalty`);
    expect(res.status).toBe(401);
  });

  it("a different tenant's customer token can't read this tenant's loyalty history", async () => {
    const otherSlug = 'customer-loyalty-salon-other';
    await createTenantWithOwner(app, { slug: otherSlug, displayName: 'Other Salon' });
    const signupRes = await request(app).post(`/api/t/${otherSlug}/account/auth/signup`).send({
      phone: '0829998888',
      name: 'Other Tenant Customer',
      password: 'a-strong-password',
    });

    const res = await request(app).get(`/api/t/${slug}/account/loyalty`).set('Authorization', `Bearer ${signupRes.body.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });
});
