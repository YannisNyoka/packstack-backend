import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';

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

const slug = 'hero-media-salon';
// Smallest possible valid MP4 container - enough to pass the mimetype check,
// the upload itself is mocked so the actual bytes never matter beyond that.
const MP4_BYTES = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');

function mockCloudinarySuccess(secureUrl) {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ secure_url: secureUrl, public_id: 'packstack/test/hero-video' }),
  });
}

describe('landing page hero settings', () => {
  let accessToken;

  beforeEach(async () => {
    await clearDatabase();
    ({ accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Hero Media Salon' }));
  });

  it('defaults heroEnabled true and heroMediaType image', async () => {
    const res = await request(app).get(`/api/t/${slug}/settings/theme`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.heroEnabled).toBe(true);
    expect(res.body.heroMediaType).toBe('image');
    expect(res.body.heroBadgeText).toBe('');
  });

  it('lets the owner toggle heroEnabled, set heroMediaType/badge, and add tiktok/website links', async () => {
    const res = await request(app)
      .patch(`/api/t/${slug}/settings/theme`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        heroEnabled: false,
        heroMediaType: 'video',
        heroBadgeText: 'Dube, Soweto · Est. 2019',
        socialLinks: { tiktok: 'https://tiktok.com/@herosalon', website: 'https://herosalon.example.com' },
      });

    expect(res.status).toBe(200);
    expect(res.body.heroEnabled).toBe(false);
    expect(res.body.heroMediaType).toBe('video');
    expect(res.body.heroBadgeText).toBe('Dube, Soweto · Est. 2019');
    expect(res.body.socialLinks.tiktok).toBe('https://tiktok.com/@herosalon');
    expect(res.body.socialLinks.website).toBe('https://herosalon.example.com');
  });

  it('uploads a hero video and writes heroVideoUrl without touching bannerUrl', async () => {
    mockCloudinarySuccess('https://res.cloudinary.com/test-cloud/video/upload/v1/packstack/test/hero-video.mp4');

    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/hero-video`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('video', MP4_BYTES, { filename: 'hero.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(200);
    expect(res.body.heroVideoUrl).toBe('https://res.cloudinary.com/test-cloud/video/upload/v1/packstack/test/hero-video.mp4');
    expect(res.body.bannerUrl).toBeNull();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/video/upload');
  });

  it('rejects a non-video file for the hero video upload', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/hero-video`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('video', Buffer.from('not a video'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });

  it('rejects a hero video over 50MB', async () => {
    const bigBuffer = Buffer.alloc(50 * 1024 * 1024 + 1024, 1);
    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/hero-video`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('video', bigBuffer, { filename: 'huge.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/50MB/);
  });

  it('rejects staff from uploading a hero video', async () => {
    const { User } = await import('../../src/models/User.js');
    const { Tenant } = await import('../../src/models/Tenant.js');
    const { hashPassword } = await import('../../src/services/authService.js');
    const { runWithTenant } = await import('../../src/lib/tenantContext.js');
    const tenant = await Tenant.findOne({ slug });
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff-hero@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app)
      .post(`/api/t/${slug}/auth/login`)
      .send({ email: 'staff-hero@example.com', password: 'staff-password-123' });

    const res = await request(app)
      .post(`/api/t/${slug}/settings/theme/hero-video`)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .attach('video', MP4_BYTES, { filename: 'hero.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(403);
  });
});
