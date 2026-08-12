import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';

let app;
let fetchSpy;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({}),
    text: async () => '',
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const slug = 'notify-salon';
const futureStart = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

async function connectBothProviders(accessToken) {
  await request(app)
    .post(`/api/t/${slug}/integrations/wati`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ accessToken: 'wati-secret-token', apiEndpoint: 'https://live-mt-server.wati.io/12345' });
  await request(app)
    .post(`/api/t/${slug}/integrations/resend`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ apiKey: 're_secret_key', fromEmail: 'bookings@notify-salon.example' });
}

describe('booking confirmation notifications', () => {
  let tenant;
  let accessToken;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Notify Salon' });
    tenant = created.tenant;
    accessToken = created.accessToken;
    seed = await seedTenantData(tenant._id);
  });

  it('sends both WhatsApp and email when both providers are connected and the customer has phone + email', async () => {
    await connectBothProviders(accessToken);

    const res = await request(app)
      .post(`/api/t/${slug}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
        customerDetails: { phone: '+27829998888', name: 'Notify Client', email: 'client@example.com' },
      });

    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const watiCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('wati.io'));
    expect(watiCall).toBeDefined();
    expect(String(watiCall[0])).toContain('/api/v1/sendSessionMessage/');
    expect(watiCall[1].headers.Authorization).toBe('Bearer wati-secret-token');

    const resendCall = fetchSpy.mock.calls.find(([url]) => String(url) === 'https://api.resend.com/emails');
    expect(resendCall).toBeDefined();
    const resendBody = JSON.parse(resendCall[1].body);
    expect(resendBody.from).toBe('bookings@notify-salon.example');
    expect(resendBody.to).toBe('client@example.com');
    expect(resendBody.subject).toContain('Notify Salon');
  });

  it('only sends WhatsApp when the customer has no email on file', async () => {
    await connectBothProviders(accessToken);

    const res = await request(app)
      .post(`/api/t/${slug}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
        customerDetails: { phone: '+27829998888', name: 'No Email Client' },
      });

    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('wati.io');
  });

  it('sends nothing when no provider is connected', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
        customerDetails: { phone: '+27829998888', name: 'Unnotified Client', email: 'client@example.com' },
      });

    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still creates the booking when the notification provider call fails', async () => {
    await connectBothProviders(accessToken);
    fetchSpy.mockRejectedValue(new Error('network down'));

    const res = await request(app)
      .post(`/api/t/${slug}/public/appointments`)
      .send({
        staffMemberId: String(seed.staff._id),
        serviceIds: [String(seed.service._id)],
        startTime: futureStart(),
        customerDetails: { phone: '+27829998888', name: 'Resilient Client', email: 'client@example.com' },
      });

    expect(res.status).toBe(201);
  });
});
