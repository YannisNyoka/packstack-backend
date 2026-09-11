import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { User } from '../../src/models/User.js';
import { hashPassword } from '../../src/services/authService.js';
import { getDecryptedCredential } from '../../src/services/integrationCredentialService.js';
import { env } from '../../src/config/env.js';

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
  let fetchSpy;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Integrations Salon' });
    tenant = created.tenant;
    ownerToken = created.accessToken;
    // connectResendCredential checks the "from" address's domain is verified
    // on Resend before allowing the connect - mocked verified by default so
    // tests that aren't specifically about that check don't need to care.
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'nxlbeautybar.co.za', status: 'verified' }] }),
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('connects a WATI credential and returns only the masked hint, never the raw token', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/integrations/wati`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ accessToken: 'super-secret-wati-token', apiEndpoint: 'https://live-mt-server.wati.io/12345' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ provider: 'wati', maskedHint: '••••oken', active: true });
  });

  it('connects a Resend credential once its "from" domain is verified on Resend', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/integrations/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 're_test_1234567890', fromEmail: 'bookings@nxlbeautybar.co.za' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ provider: 'resend', maskedHint: '••••7890', active: true });
    expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/domains', expect.objectContaining({
      headers: { Authorization: 'Bearer re_test_1234567890' },
    }));
  });

  it('rejects connecting Resend with a "from" address at an unverifiable consumer domain like gmail.com', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }); // gmail.com will never show up as a verified domain here

    const res = await request(app)
      .post(`/api/t/${slug}/integrations/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 're_test_1234567890', fromEmail: 'owner@gmail.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOMAIN_NOT_VERIFIED');
    expect(res.body.error.message).toContain('gmail.com');

    const decrypted = await runWithTenant(tenant._id, async () => getDecryptedCredential('resend'));
    expect(decrypted).toBeNull(); // nothing stored - a silently-broken connection is worse than none
  });

  it('rejects connecting Resend with a "from" domain that exists on the account but is still pending verification', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ data: [{ name: 'nxlbeautybar.co.za', status: 'pending' }] }) });

    const res = await request(app)
      .post(`/api/t/${slug}/integrations/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 're_test_1234567890', fromEmail: 'bookings@nxlbeautybar.co.za' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOMAIN_NOT_VERIFIED');
  });

  it('rejects the connect attempt when Resend refuses the API key outright', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Invalid API key' }) });

    const res = await request(app)
      .post(`/api/t/${slug}/integrations/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 're_test_wrong', fromEmail: 'bookings@nxlbeautybar.co.za' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid api key/i);
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

describe('Yoco: registers the webhook subscription automatically', () => {
  let tenant;
  let ownerToken;
  let fetchSpy;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Integrations Salon' });
    tenant = created.tenant;
    ownerToken = created.accessToken;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("connects with only a secret key - Yoco's generated webhook secret is stored, never asked of the tenant", async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'sub_123', name: 'PackStack deposits - integrations-salon', mode: 'test', secret: 'whsec_c2VjcmV0Zm9ydGVzdGluZzEyMzQ=' }),
    });

    const res = await request(app)
      .post(`/api/t/${slug}/integrations/yoco`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ secretKey: 'sk_test_abc123' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ provider: 'yoco', maskedHint: '••••c123', active: true });

    // Registered on the Checkout API's own webhooks endpoint (same host,
    // same secret key as checkout creation) - confirmed live against
    // Yoco's API. The separate api.yoco.com "Yoco API" webhooks system
    // (a different credential entirely) was a dead end.
    const [fetchUrl, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchUrl).toBe('https://payments.yoco.com/api/webhooks');
    expect(fetchOpts.headers.Authorization).toBe('Bearer sk_test_abc123');
    const sentBody = JSON.parse(fetchOpts.body);
    expect(sentBody.url).toBe(`${env.API_BASE_URL}/api/t/${slug}/public/deposit-webhook`);

    const decrypted = await runWithTenant(tenant._id, () => getDecryptedCredential('yoco'));
    expect(decrypted).toEqual({ secretKey: 'sk_test_abc123', webhookSecret: 'whsec_c2VjcmV0Zm9ydGVzdGluZzEyMzQ=' });
  });

  it('rejects the connect attempt (and stores nothing) when Yoco refuses the secret key', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'The provided credentials are invalid.' }),
    });

    const res = await request(app)
      .post(`/api/t/${slug}/integrations/yoco`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ secretKey: 'sk_test_wrong' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid/i);

    const decrypted = await runWithTenant(tenant._id, () => getDecryptedCredential('yoco'));
    expect(decrypted).toBeNull();
  });

  it('rejects a connect payload with no secret key', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/integrations/yoco`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
