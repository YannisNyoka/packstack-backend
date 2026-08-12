import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Appointment } from '../../src/models/Appointment.js';
import { sendDueReminders } from '../../src/services/reminderService.js';

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
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}), text: async () => '' });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const slug = 'reminder-salon';
const hoursFromNow = (h) => new Date(Date.now() + h * 60 * 60 * 1000);

async function connectBothProviders(accessToken) {
  await request(app)
    .post(`/api/t/${slug}/integrations/wati`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ accessToken: 'wati-secret-token', apiEndpoint: 'https://live-mt-server.wati.io/12345' });
  await request(app)
    .post(`/api/t/${slug}/integrations/resend`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ apiKey: 're_secret_key', fromEmail: 'bookings@reminder-salon.example' });
}

async function makeAppointment(tenantId, seed, { startTime, status = 'booked', reminderSentAt = null }) {
  return runWithTenant(tenantId, async () =>
    Appointment.create({
      customerId: seed.customer._id,
      staffMemberId: seed.staff._id,
      serviceIds: [seed.service._id],
      startTime,
      endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
      status,
      priceSnapshot: seed.service.price,
      reminderSentAt,
    })
  );
}

// seedTenantData's Customer has no email (see tests/helpers/factories.js -
// other suites rely on that to test the "WhatsApp only" branch), so tests
// here that need both channels give this customer an email first.
async function giveCustomerEmail(tenantId, seed, email) {
  return runWithTenant(tenantId, async () => {
    seed.customer.email = email;
    await seed.customer.save();
  });
}

async function findAppointment(tenantId, appointmentId) {
  return runWithTenant(tenantId, async () => Appointment.findById(appointmentId));
}

describe('reminderService.sendDueReminders', () => {
  let tenant;
  let accessToken;
  let seed;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Reminder Salon' });
    tenant = created.tenant;
    accessToken = created.accessToken;
    seed = await seedTenantData(tenant._id);
  });

  it('sends a reminder for an appointment inside the 24h window and marks it sent', async () => {
    await connectBothProviders(accessToken);
    await giveCustomerEmail(tenant._id, seed, 'client@example.com');
    const appt = await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(20) });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // WhatsApp + email

    const resendCall = fetchSpy.mock.calls.find(([url]) => String(url) === 'https://api.resend.com/emails');
    const body = JSON.parse(resendCall[1].body);
    expect(body.subject).toContain('Reminder');
    expect(body.html).toContain('tomorrow');

    const updated = await findAppointment(tenant._id, appt._id);
    expect(updated.reminderSentAt).not.toBeNull();
  });

  it('does not send for an appointment further than 24h out', async () => {
    await connectBothProviders(accessToken);
    await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(48) });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not re-send once reminderSentAt is already set', async () => {
    await connectBothProviders(accessToken);
    await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(10), reminderSentAt: new Date() });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not send for a cancelled appointment inside the window', async () => {
    await connectBothProviders(accessToken);
    await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(12), status: 'cancelled' });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(0);
  });

  it('does not send for an appointment already in the past', async () => {
    await connectBothProviders(accessToken);
    await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(-2) });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(0);
  });

  it('is a no-op when no provider is connected, but still marks the appointment as reminded', async () => {
    const appt = await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(5) });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    const updated = await findAppointment(tenant._id, appt._id);
    expect(updated.reminderSentAt).not.toBeNull();
  });

  it('marks the appointment reminded even if every channel fails', async () => {
    await connectBothProviders(accessToken);
    fetchSpy.mockRejectedValue(new Error('network down'));
    const appt = await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(6) });

    const result = await sendDueReminders();

    expect(result.sentCount).toBe(1);
    const updated = await findAppointment(tenant._id, appt._id);
    expect(updated.reminderSentAt).not.toBeNull();
  });

  it('checks every tenant and only reminds the appointments due in each', async () => {
    const slug2 = 'reminder-salon-two';
    const created2 = await createTenantWithOwner(app, { slug: slug2, displayName: 'Reminder Salon Two' });
    const seed2 = await seedTenantData(created2.tenant._id);
    await connectBothProviders(accessToken);

    await makeAppointment(tenant._id, seed, { startTime: hoursFromNow(5) });
    await makeAppointment(created2.tenant._id, seed2, { startTime: hoursFromNow(5) });

    const result = await sendDueReminders();

    expect(result.checkedTenants).toBeGreaterThanOrEqual(2);
    expect(result.sentCount).toBe(2);
  });
});
