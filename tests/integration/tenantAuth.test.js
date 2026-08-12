import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'me-endpoint-salon';

describe('GET /api/t/:slug/auth/me', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it("returns the logged-in owner's id/email/role/tenantStatus/trialEndsAt", async () => {
    const { accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Me Endpoint Salon', ownerEmail: 'owner@me-endpoint.example' });

    const res = await request(app).get(`/api/t/${slug}/auth/me`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: expect.any(String),
      email: 'owner@me-endpoint.example',
      role: 'owner',
      tenantStatus: 'trial',
      trialEndsAt: expect.any(String),
    });
  });

  it('rejects with no token', async () => {
    await createTenantWithOwner(app, { slug, displayName: 'Me Endpoint Salon' });
    const res = await request(app).get(`/api/t/${slug}/auth/me`);
    expect(res.status).toBe(401);
  });
});
