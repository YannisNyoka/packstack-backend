import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { StaffMember } from '../../src/models/StaffMember.js';
import { User } from '../../src/models/User.js';
import { hashPassword } from '../../src/services/authService.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'time-off-salon';

describe('staff time-off', () => {
  let tenant;
  let ownerToken;
  let staffToken;
  let staffMember;

  beforeEach(async () => {
    await clearDatabase();
    ({ tenant, accessToken: ownerToken } = await createTenantWithOwner(app, { slug, displayName: 'Time Off Salon' }));

    await runWithTenant(tenant._id, async () => {
      staffMember = await StaffMember.create({ name: 'Thandi', servicesOffered: [] });
      const passwordHash = await hashPassword('staff-password-123');
      await User.create({ email: 'staff@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'staff@example.com', password: 'staff-password-123' });
    staffToken = loginRes.body.accessToken;
  });

  it('lets the owner create a whole-day time-off entry', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01', reason: 'Sick day' });

    expect(res.status).toBe(201);
    expect(res.body.date).toBe('2026-09-01');
    expect(res.body.startTime).toBeNull();
    expect(res.body.reason).toBe('Sick day');
  });

  it('lets the owner create a partial-day time-off entry', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01', startTime: '14:00', endTime: '16:00', reason: 'Personal appointment' });

    expect(res.status).toBe(201);
    expect(res.body.startTime).toBe('14:00');
    expect(res.body.endTime).toBe('16:00');
  });

  it('rejects startTime without endTime', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01', startTime: '14:00' });
    expect(res.status).toBe(400);
  });

  it('rejects startTime after endTime', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01', startTime: '16:00', endTime: '14:00' });
    expect(res.status).toBe(400);
  });

  it('404s for a staff member that does not exist', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/64b000000000000000000000/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01' });
    expect(res.status).toBe(404);
  });

  it('rejects staff from creating a time-off entry', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ date: '2026-09-01' });
    expect(res.status).toBe(403);
  });

  it('lets staff read time-off entries', async () => {
    await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01', reason: 'Sick day' });

    const res = await request(app)
      .get(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('filters listed time-off entries by date range', async () => {
    await request(app).post(`/api/t/${slug}/staff/${staffMember._id}/time-off`).set('Authorization', `Bearer ${ownerToken}`).send({ date: '2026-09-01' });
    await request(app).post(`/api/t/${slug}/staff/${staffMember._id}/time-off`).set('Authorization', `Bearer ${ownerToken}`).send({ date: '2026-10-01' });

    const res = await request(app)
      .get(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .query({ from: '2026-09-15', to: '2026-10-15' })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].date).toBe('2026-10-01');
  });

  it('lets the owner delete a time-off entry', async () => {
    const createRes = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01' });

    const deleteRes = await request(app)
      .delete(`/api/t/${slug}/staff/${staffMember._id}/time-off/${createRes.body._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app)
      .get(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(listRes.body).toHaveLength(0);
  });

  it('rejects staff from deleting a time-off entry', async () => {
    const createRes = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01' });

    const res = await request(app)
      .delete(`/api/t/${slug}/staff/${staffMember._id}/time-off/${createRes.body._id}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });

  it('404s deleting a time-off entry that does not belong to this staff member', async () => {
    const otherStaff = await runWithTenant(tenant._id, async () => StaffMember.create({ name: 'Noxolo', servicesOffered: [] }));
    const createRes = await request(app)
      .post(`/api/t/${slug}/staff/${staffMember._id}/time-off`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-09-01' });

    const res = await request(app)
      .delete(`/api/t/${slug}/staff/${otherStaff._id}/time-off/${createRes.body._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });
});
