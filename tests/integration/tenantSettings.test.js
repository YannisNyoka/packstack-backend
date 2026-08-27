import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { hashPassword } from '../../src/services/authService.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'settings-salon';

describe('tenant booking-rules settings', () => {
  let accessToken;

  beforeEach(async () => {
    await clearDatabase();
    ({ accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Settings Salon' }));
  });

  it('returns the default booking rules', async () => {
    const res = await request(app).get(`/api/t/${slug}/settings/booking-rules`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rescheduleWindowHours: 36,
      sameDayCutoffTime: '18:00',
      cancellationWindowHours: 36,
      depositRequired: false,
      depositAmountZAR: 0,
    });
  });

  it('lets the owner update booking rules, including deposit settings', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/booking-rules`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ depositRequired: true, depositAmountZAR: 250, sameDayCutoffTime: '15:00' });

    expect(res.status).toBe(200);
    expect(res.body.depositRequired).toBe(true);
    expect(res.body.depositAmountZAR).toBe(250);
    expect(res.body.sameDayCutoffTime).toBe('15:00');
    // Untouched fields keep their previous values.
    expect(res.body.rescheduleWindowHours).toBe(36);
  });

  it('rejects staff from updating booking rules', async () => {
    const { User } = await import('../../src/models/User.js');
    const { Tenant } = await import('../../src/models/Tenant.js');
    const tenant = await Tenant.findOne({ slug });
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'staff@example.com', password: 'staff-password-123' });

    const res = await request(app)
      .patch(`/api/t/${slug}/settings/booking-rules`)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .send({ depositRequired: true });
    expect(res.status).toBe(403);
  });

  it('rejects invalid values', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/booking-rules`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ depositAmountZAR: -50 });
    expect(res.status).toBe(400);
  });
});

describe('tenant theme (branding) settings', () => {
  let accessToken;

  beforeEach(async () => {
    await clearDatabase();
    ({ accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Settings Salon' }));
  });

  it('returns the default theme created at provisioning', async () => {
    const res = await request(app).get(`/api/t/${slug}/settings/theme`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      businessName: 'Settings Salon',
      tagline: '',
      logoUrl: null,
      template: 'classic',
      colors: { primary: '#111827', secondary: '#6B7280', accent: '#D946EF' },
      contactInfo: { phone: '', email: '', address: '' },
      socialLinks: { instagram: '', facebook: '', whatsapp: '' },
    });
  });

  it('lets the owner switch templates, and it persists', async () => {
    const patchRes = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ template: 'modern' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.template).toBe('modern');

    const getRes = await request(app).get(`/api/t/${slug}/settings/theme`).set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.body.template).toBe('modern');
  });

  it('rejects an unknown template', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ template: 'not-a-real-template' });
    expect(res.status).toBe(400);
  });

  it('lets the owner update branding, merging nested fields instead of replacing them', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tagline: 'Nails, hair, beauty.',
        logoUrl: 'https://cdn.example.com/logo.png',
        colors: { primary: '#2f6fed' },
        contactInfo: { phone: '011 555 0100' },
      });

    expect(res.status).toBe(200);
    expect(res.body.tagline).toBe('Nails, hair, beauty.');
    expect(res.body.logoUrl).toBe('https://cdn.example.com/logo.png');
    // Only primary was sent - secondary/accent must survive untouched.
    expect(res.body.colors).toMatchObject({ primary: '#2f6fed', secondary: '#6B7280', accent: '#D946EF' });
    // Only phone was sent - email/address must survive untouched.
    expect(res.body.contactInfo).toMatchObject({ phone: '011 555 0100', email: '', address: '' });
    // businessName wasn't touched at all.
    expect(res.body.businessName).toBe('Settings Salon');
  });

  it('rejects an invalid hex color', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ colors: { primary: 'blue' } });
    expect(res.status).toBe(400);
  });

  it('rejects a logoUrl that is not http(s)', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ logoUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  it('rejects staff from updating branding', async () => {
    const { User } = await import('../../src/models/User.js');
    const { Tenant } = await import('../../src/models/Tenant.js');
    const tenant = await Tenant.findOne({ slug });
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff-theme@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app)
      .post(`/api/t/${slug}/auth/login`)
      .send({ email: 'staff-theme@example.com', password: 'staff-password-123' });

    const res = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .send({ tagline: 'Should not work' });
    expect(res.status).toBe(403);
  });
});
