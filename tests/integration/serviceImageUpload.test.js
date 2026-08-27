import { jest } from '@jest/globals';
import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { hashPassword } from '../../src/services/authService.js';

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

const slug = 'service-image-salon';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function mockCloudinarySuccess(secureUrl) {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ secure_url: secureUrl, public_id: 'packstack/test/services/x' }),
  });
}

describe('service image uploads', () => {
  let accessToken;
  let serviceId;

  beforeEach(async () => {
    await clearDatabase();
    ({ accessToken } = await createTenantWithOwner(app, { slug, displayName: 'Service Image Salon' }));

    const createRes = await request(app)
      .post(`/api/t/${slug}/services`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Haircut', durationMinutes: 30, price: 150 });
    serviceId = createRes.body._id;
  });

  it('has no image by default', async () => {
    const res = await request(app).get(`/api/t/${slug}/services/${serviceId}`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.body.imageUrl).toBe('');
  });

  it('uploads a photo, sets imageUrl, and Cloudinary receives a service-scoped publicId', async () => {
    mockCloudinarySuccess(`https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/services/${serviceId}.png`);

    const res = await request(app)
      .post(`/api/t/${slug}/services/${serviceId}/image`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBe(`https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/services/${serviceId}.png`);
    // Everything else about the service must be untouched by the upload.
    expect(res.body.name).toBe('Haircut');

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.body.get('public_id')).toMatch(new RegExp(`^packstack/[a-f0-9]{24}/services/${serviceId}$`));

    const getRes = await request(app).get(`/api/t/${slug}/services/${serviceId}`).set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.body.imageUrl).toBe(`https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/services/${serviceId}.png`);
  });

  it('clearing imageUrl via PATCH removes the photo', async () => {
    mockCloudinarySuccess('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/services/x.png');
    await request(app)
      .post(`/api/t/${slug}/services/${serviceId}/image`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    const patchRes = await request(app)
      .patch(`/api/t/${slug}/services/${serviceId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ imageUrl: '' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.imageUrl).toBe('');
  });

  it('rejects a non-image file', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/services/${serviceId}/image`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });

  it('rejects a file over 5MB', async () => {
    const bigBuffer = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);
    const res = await request(app)
      .post(`/api/t/${slug}/services/${serviceId}/image`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', bigBuffer, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/5MB/);
  });

  it('404s for a service that does not exist', async () => {
    mockCloudinarySuccess('https://res.cloudinary.com/test-cloud/image/upload/v1/packstack/test/services/missing.png');
    const res = await request(app)
      .post(`/api/t/${slug}/services/6a778ea61fb0712f01002b66/image`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(404);
  });

  it('rejects staff from uploading a service photo', async () => {
    const { User } = await import('../../src/models/User.js');
    const { Tenant } = await import('../../src/models/Tenant.js');
    const tenant = await Tenant.findOne({ slug });
    const passwordHash = await hashPassword('staff-password-123');
    await runWithTenant(tenant._id, async () => {
      await User.create({ email: 'staff-svc-image@example.com', passwordHash, role: 'staff' });
    });
    const loginRes = await request(app)
      .post(`/api/t/${slug}/auth/login`)
      .send({ email: 'staff-svc-image@example.com', password: 'staff-password-123' });

    const res = await request(app)
      .post(`/api/t/${slug}/services/${serviceId}/image`)
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .attach('image', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});
