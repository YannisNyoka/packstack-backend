import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { Plan } from '../../src/models/Plan.js';

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

describe('GET /api/public/plans', () => {
  it('returns an empty array when no plans exist yet', async () => {
    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists active plans sorted by price, with no auth required', async () => {
    await Plan.create({
      key: 'growth',
      name: 'Growth',
      priceZAR: 599,
      billingInterval: 'monthly',
      limits: { maxStaff: 6, maxAppointmentsPerMonth: 500, whatsappMessagesPerMonth: 1000, customDomainAllowed: true },
    });
    await Plan.create({
      key: 'starter',
      name: 'Starter',
      priceZAR: 299,
      billingInterval: 'monthly',
      limits: { maxStaff: 2, maxAppointmentsPerMonth: 150, whatsappMessagesPerMonth: 200, customDomainAllowed: false },
    });

    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((p) => p.key)).toEqual(['starter', 'growth']); // sorted by price ascending
    expect(res.body[0]).toMatchObject({
      key: 'starter',
      name: 'Starter',
      priceZAR: 299,
      billingInterval: 'monthly',
      limits: { maxStaff: 2, maxAppointmentsPerMonth: 150, whatsappMessagesPerMonth: 200, customDomainAllowed: false },
    });
  });

  it('excludes inactive plans', async () => {
    await Plan.create({
      key: 'retired',
      name: 'Retired Plan',
      priceZAR: 199,
      billingInterval: 'monthly',
      limits: { maxStaff: 1, maxAppointmentsPerMonth: 50, whatsappMessagesPerMonth: 50, customDomainAllowed: false },
      active: false,
    });

    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
