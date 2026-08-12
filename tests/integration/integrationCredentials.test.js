import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { User } from '../../src/models/User.js';
import { hashPassword } from '../../src/services/authService.js';
import { getDecryptedCredential } from '../../src/services/integrationCredentialService.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'integrations-salon';

describe('Integration credentials (WATI/Resend)', () => {
  let tenant;
  let ownerToken;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Integrations Salon' });
    tenant = created.tenant;
    ownerToken = created.accessToken;
  });

  it('connects a WATI credential and returns only the masked hint, never the raw token', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/integrations/wati`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ accessToken: 'super-secret-wati-token', apiEndpoint: 'https://live-mt-server.wati.io/12345' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ provider: 'wati', maskedHint: '••••oken', active: true });
  });

  it('connects a Resend credential', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/integrations/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 're_test_1234567890', fromEmail: 'bookings@nxlbeautybar.co.za' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ provider: 'resend', maskedHint: '••••7890', active: true });
  });

  it('rejects an invalid connect payload (e.g. non-URL apiEndpoint)', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/integrations/wati`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ accessToken: 'token', apiEndpoint: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('lists connected credentials without ever exposing the encrypted value', async () => {
    await request(app)
      .post(`/api/t/${slug}/integrations/wati`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ accessToken: 'super-secret-wati-token', apiEndpoint: 'https://live-mt-server.wati.io/12345' });

    const res = await request(app).get(`/api/t/${slug}/integrations`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ provider: 'wati', maskedHint: '••••oken', active: true });
    expect(res.body[0].encryptedValue).toBeUndefined();
  });

  it('disconnect deactivates rather than deletes the credential', async () => {
    await request(app)
      .post(`/api/t/${slug}/integrations/wati`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ accessToken: 'super-secret-wati-token', apiEndpoint: 'https://live-mt-server.wati.io/12345' });

    const disconnectRes = await request(app).delete(`/api/t/${slug}/integrations/wati`).set('Authorization', `Bearer ${ownerToken}`);
    expect(disconnectRes.status).toBe(200);
    expect(disconnectRes.body.active).toBe(false);

    const listRes = await request(app).get(`/api/t/${slug}/integrations`).set('Authorization', `Bearer ${ownerToken}`);
    expect(listRes.body.find((c) => c.provider === 'wati').active).toBe(false);
  });

  it('404s disconnecting a provider that was never connected', async () => {
    const res = await request(app).delete(`/api/t/${slug}/integrations/resend`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('rejects a staff-role account from managing integrations', async () => {
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app)
      .post(`/api/t/${slug}/auth/login`)
      .send({ email: 'staff@example.com', password: 'staff-password-123' });

    const res = await request(app).get(`/api/t/${slug}/integrations`).set('Authorization', `Bearer ${loginRes.body.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('round-trips the stored payload through envelope encryption correctly', async () => {
    await request(app)
      .post(`/api/t/${slug}/integrations/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 're_test_1234567890', fromEmail: 'bookings@nxlbeautybar.co.za' });

    const decrypted = await runWithTenant(tenant._id, () => getDecryptedCredential('resend'));
    expect(decrypted).toEqual({ apiKey: 're_test_1234567890', fromEmail: 'bookings@nxlbeautybar.co.za' });
  });
});
