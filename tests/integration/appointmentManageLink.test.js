import jwt from 'jsonwebtoken';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { signAppointmentManageToken } from '../../src/lib/jwt.js';
import { env } from '../../src/config/env.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slugA = 'manage-salon-a';
const slugB = 'manage-salon-b';
const futureStart = (daysAhead) => new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);

async function bookAppointment({ slug, seed, startTime }) {
  const res = await request(app)
    .post(`/api/t/${slug}/public/appointments`)
    .send({
      staffMemberId: String(seed.staff._id),
      serviceIds: [String(seed.service._id)],
      startTime: startTime.toISOString(),
      customerDetails: { phone: '+27821239999', name: 'Manage Link Client' },
    });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Signed appointment-manage link (view/reschedule/cancel with no login)', () => {
  let tenantA;
  let tenantB;
  let seedA;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant: tenantA } = await createTenantWithOwner(app, { slug: slugA, displayName: 'Manage Salon A' }));
    ({ tenant: tenantB } = await createTenantWithOwner(app, { slug: slugB, displayName: 'Manage Salon B' }));
    seedA = await seedTenantData(tenantA._id);
    await seedTenantData(tenantB._id);
  });

  it('GET resolves the appointment for a valid token', async () => {
    const startTime = futureStart(10);
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });

    const res = await request(app).get(`/api/t/${slugA}/public/appointments/manage`).query({ token });
    expect(res.status).toBe(200);
    expect(res.body._id).toBe(appointment._id);
  });

  it('rejects a token used against a different tenant\'s URL', async () => {
    const startTime = futureStart(10);
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });

    const res = await request(app).get(`/api/t/${slugB}/public/appointments/manage`).query({ token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).get(`/api/t/${slugA}/public/appointments/manage`).query({ token: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('rejects an already-expired token', async () => {
    const expiredToken = jwt.sign({ sub: 'irrelevant', tenantId: String(tenantA._id) }, env.APPOINTMENT_LINK_SECRET, {
      audience: 'packstack-appointment-manage',
      expiresIn: -10,
    });
    const res = await request(app).get(`/api/t/${slugA}/public/appointments/manage`).query({ token: expiredToken });
    expect(res.status).toBe(401);
  });

  it('404s if the token names an appointment that belongs to a different tenant than it claims (ODM backstop)', async () => {
    const startTime = futureStart(10);
    const appointmentA = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    // Models the case where the tenantId claim were somehow wrong for this
    // appointment id - the tenant-mismatch check above passes (claim matches
    // the URL), but tenantScopePlugin still won't find tenant A's document
    // under tenant B's bound context.
    const mismatchedToken = signAppointmentManageToken({ appointmentId: appointmentA._id, tenantId: tenantB._id, expiresAt: startTime });

    const res = await request(app).get(`/api/t/${slugB}/public/appointments/manage`).query({ token: mismatchedToken });
    expect(res.status).toBe(404);
  });

  it('reschedules via the link when outside the reschedule window', async () => {
    const startTime = futureStart(10); // outside the default 36h reschedule window
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });
    const newStartTime = futureStart(11).toISOString();

    const res = await request(app).patch(`/api/t/${slugA}/public/appointments/manage/reschedule`).send({ token, newStartTime });
    expect(res.status).toBe(200);
    expect(new Date(res.body.startTime).toISOString()).toBe(new Date(newStartTime).toISOString());
  });

  it('rejects a reschedule inside the tenant reschedule window', async () => {
    const startTime = futureStart(1); // 24h out, inside the default 36h window
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });

    const res = await request(app)
      .patch(`/api/t/${slugA}/public/appointments/manage/reschedule`)
      .send({ token, newStartTime: futureStart(2).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESCHEDULE_WINDOW');
  });

  it('cancels via the link when outside the cancellation window', async () => {
    const startTime = futureStart(10);
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });

    const res = await request(app).patch(`/api/t/${slugA}/public/appointments/manage/cancel`).send({ token, reason: 'change of plans' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('rejects a cancel inside the tenant cancellation window', async () => {
    const startTime = futureStart(1); // 24h out, inside the default 36h window
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });

    const res = await request(app).patch(`/api/t/${slugA}/public/appointments/manage/cancel`).send({ token, reason: 'too late' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW');
  });

  it('a used-up (cancelled) appointment cannot be rescheduled via the same link afterwards', async () => {
    const startTime = futureStart(10);
    const appointment = await bookAppointment({ slug: slugA, seed: seedA, startTime });
    const token = signAppointmentManageToken({ appointmentId: appointment._id, tenantId: tenantA._id, expiresAt: startTime });

    await request(app).patch(`/api/t/${slugA}/public/appointments/manage/cancel`).send({ token });

    const res = await request(app)
      .patch(`/api/t/${slugA}/public/appointments/manage/reschedule`)
      .send({ token, newStartTime: futureStart(11).toISOString() });
    expect(res.status).toBe(400);
  });
});
