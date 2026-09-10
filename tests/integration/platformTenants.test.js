import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner, seedTenantData } from '../helpers/factories.js';
import { SuperAdminUser } from '../../src/models/SuperAdminUser.js';
import { hashPassword } from '../../src/services/authService.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { Tenant } from '../../src/models/Tenant.js';
import { User } from '../../src/models/User.js';
import { Service } from '../../src/models/Service.js';
import { StaffMember } from '../../src/models/StaffMember.js';
import { Customer } from '../../src/models/Customer.js';
import { AuditLog } from '../../src/models/AuditLog.js';

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

async function superAdminToken() {
  const email = 'admin@packstack.co.za';
  const password = 'a-strong-superadmin-password';
  await SuperAdminUser.create({ email, passwordHash: await hashPassword(password) });
  const res = await request(app).post('/api/platform/auth/login').send({ email, password });
  return res.body.accessToken;
}

const slug = 'manage-salon';

describe('GET /api/platform/tenants/:id', () => {
  it("returns the tenant plus its owner and subscription (null until they've subscribed)", async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    const token = await superAdminToken();

    const res = await request(app).get(`/api/platform/tenants/${tenant._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenant.slug).toBe(slug);
    expect(res.body.owner.email).toBe('owner@example.com');
    expect(res.body.subscription).toBeNull();
  });

  it('404s for an unknown tenant id', async () => {
    const token = await superAdminToken();
    const res = await request(app).get('/api/platform/tenants/507f1f77bcf86cd799439011').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/platform/tenants/:id', () => {
  it('updates the business name but not the slug', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    const token = await superAdminToken();

    const res = await request(app)
      .patch(`/api/platform/tenants/${tenant._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Renamed Salon' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Renamed Salon');
    expect(res.body.slug).toBe(slug);
  });
});

describe('PATCH /api/platform/tenants/:id/owner', () => {
  it("changes the owner's login email", async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    const token = await superAdminToken();

    const res = await request(app)
      .patch(`/api/platform/tenants/${tenant._id}/owner`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new-owner@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('new-owner@example.com');

    const loginRes = await request(app)
      .post(`/api/t/${slug}/auth/login`)
      .send({ email: 'new-owner@example.com', password: 'correct-horse-battery-staple' });
    expect(loginRes.status).toBe(200);
  });
});

describe('PATCH /api/platform/tenants/:id/status', () => {
  it('applies a manual status override', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    const token = await superAdminToken();

    const res = await request(app)
      .patch(`/api/platform/tenants/${tenant._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('rejects a status outside the known set', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    const token = await superAdminToken();

    const res = await request(app)
      .patch(`/api/platform/tenants/${tenant._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/platform/tenants/:id', () => {
  it('rejects when the confirmation slug does not match', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    const token = await superAdminToken();

    const res = await request(app)
      .delete(`/api/platform/tenants/${tenant._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'wrong-slug' });
    expect(res.status).toBe(400);

    const stillThere = await Tenant.findById(tenant._id);
    expect(stillThere).not.toBeNull();
  });

  it('cascades across every tenant-scoped collection but leaves the audit trail behind', async () => {
    const { tenant } = await createTenantWithOwner(app, { slug, displayName: 'Manage Salon' });
    await seedTenantData(tenant._id);
    const token = await superAdminToken();

    const res = await request(app)
      .delete(`/api/platform/tenants/${tenant._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug });
    expect(res.status).toBe(204);

    expect(await Tenant.findById(tenant._id)).toBeNull();

    await runWithTenant(tenant._id, async () => {
      expect(await User.countDocuments({})).toBe(0);
      expect(await Service.countDocuments({})).toBe(0);
      expect(await StaffMember.countDocuments({})).toBe(0);
      expect(await Customer.countDocuments({})).toBe(0);

      const logs = await AuditLog.find({ action: 'platform.tenant_deleted' });
      expect(logs).toHaveLength(1);
      expect(logs[0].diff.before.slug).toBe(slug);
    });
  });
});
