import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { hashPassword } from '../../src/services/authService.js';
import { env } from '../../src/config/env.js';

let app;
let fetchSpy;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

afterEach(() => {
  fetchSpy?.mockRestore();
});

const slug = 'media-salon';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function mockCloudinarySuccess(secureUrl) {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ secure_url: secureUrl, public_id: 'packstack/test/logo' }),
  });
}

describe('theme image uploads', () => {
  let accessToken;

  beforeEach(async () => {
    await clearDatabase();
    ({ accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Media Salon' }));
  });

  it('uploads a logo, updates the theme, and Cloudinary receives the right publicId', async () => {
    mockCloudinarySuccess('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/logo.png');

    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/logo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBe('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/logo.png');
    // bannerUrl must be untouched by a logo upload.
    expect(res.body.bannerUrl).toBeNull();

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.body.get('overwrite')).toBe('true');
    expect(options.body.get('public_id')).toMatch(/^packstack\/[a-f0-9]{24}\/logo$/);

    const getRes = await request(app).get(`/api/t/${slug}/settings/theme`).set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.body.logoUrl).toBe('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/logo.png');
  });

  it('uploads a banner into bannerUrl, not logoUrl', async () => {
    mockCloudinarySuccess('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/banner.png');

    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/banner`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'banner.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.bannerUrl).toBe('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/banner.png');
    expect(res.body.logoUrl).toBeNull();
  });

  it('rejects a non-image file', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/logo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });

  it('rejects a file over 5MB', async () => {
    const bigBuffer = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);
    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/logo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', bigBuffer, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/5MB/);
  });

  it('rejects when no file is attached', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/logo`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('fails clearly when Cloudinary is not configured', async () => {
    const original = env.CLOUDINARY_CLOUD_NAME;
    env.CLOUDINARY_CLOUD_NAME = undefined;
    try {
      const res = await request(app)
        .post(`/api/t/${slug}/settings/theme/logo`)
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('image', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not configured/);
    } finally {
      env.CLOUDINARY_CLOUD_NAME = original;
    }
  });

  it('surfaces a Cloudinary-side failure as a clear 400 rather than a 500', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    });

    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/logo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Invalid API key/);
  });

  it('rejects staff from uploading a logo', async () => {
    const { User } = await import('../../src/models/User.js');
    const { Tenant } = await import('../../src/models/Tenant.js');
    const tenant = await Tenant.findOne({ slug });
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff-media@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app)
      .post(`/api/t/${slug}/auth/login`)
      .send({ email: 'staff-media@example.com', password: 'staff-password-123' });

    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/logo`)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});
