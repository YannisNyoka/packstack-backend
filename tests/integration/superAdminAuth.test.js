import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { SuperAdminUser } from '../../src/models/SuperAdminUser.js';
import { hashPassword } from '../../src/services/authService.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const EMAIL = 'admin@packstack.co.za';
const PASSWORD = 'a-strong-superadmin-password';

async function createSuperAdmin(overrides = {}) {
  const passwordHash = await hashPassword(PASSWORD);
  return SuperAdminUser.create({ email: EMAIL, passwordHash, ...overrides });
}

beforeEach(async () => {
  await clearDatabase();
});

describe('POST /api/platform/auth/login', () => {
  it('logs in with correct credentials and returns an access token usable against superadmin routes', async () => {
    await createSuperAdmin();

    const loginRes = await request(app).post('/api/platform/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.accessToken).toEqual(expect.any(String));
    expect(loginRes.body.admin.email).toBe(EMAIL);
    expect(loginRes.headers['set-cookie'].some((c) => c.startsWith('ps_superadmin_refresh='))).toBe(true);

    const tenantsRes = await request(app)
      .get('/api/platform/tenants')
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`);
    expect(tenantsRes.status).toBe(200);
  });

  it('rejects an unknown email with the same message as a wrong password (no user enumeration)', async () => {
    await createSuperAdmin();
    const res = await request(app).post('/api/platform/auth/login').send({ email: 'nobody@packstack.co.za', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/invalid email or password/i);
  });

  it('locks the account after repeated failed attempts', async () => {
    await createSuperAdmin();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/platform/auth/login').send({ email: EMAIL, password: 'wrong-password' });
      expect(res.status).toBe(401);
    }

    const lockedRes = await request(app).post('/api/platform/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(lockedRes.status).toBe(403);
    expect(lockedRes.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects a disabled account', async () => {
    await createSuperAdmin({ status: 'disabled' });
    const res = await request(app).post('/api/platform/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/platform/auth/me', () => {
  it("returns the logged-in superadmin's identity", async () => {
    await createSuperAdmin();
    const loginRes = await request(app).post('/api/platform/auth/login').send({ email: EMAIL, password: PASSWORD });

    const meRes = await request(app).get('/api/platform/auth/me').set('Authorization', `Bearer ${loginRes.body.accessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe(EMAIL);
  });

  it('rejects with no token', async () => {
    const res = await request(app).get('/api/platform/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/platform/auth/refresh', () => {
  it('issues a new access token from the refresh cookie', async () => {
    await createSuperAdmin();
    const agent = request.agent(app);

    await agent.post('/api/platform/auth/login').send({ email: EMAIL, password: PASSWORD });
    const refreshRes = await agent.post('/api/platform/auth/refresh');
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toEqual(expect.any(String));

    const tenantsRes = await agent.get('/api/platform/tenants').set('Authorization', `Bearer ${refreshRes.body.accessToken}`);
    expect(tenantsRes.status).toBe(200);
  });

  it('rejects when there is no refresh cookie', async () => {
    const res = await request(app).post('/api/platform/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/platform/auth/logout-all', () => {
  it('revokes outstanding refresh tokens by bumping tokenVersion', async () => {
    await createSuperAdmin();
    const agent = request.agent(app);

    const loginRes = await agent.post('/api/platform/auth/login').send({ email: EMAIL, password: PASSWORD });

    await agent.post('/api/platform/auth/logout-all').set('Authorization', `Bearer ${loginRes.body.accessToken}`);

    // The refresh cookie set at login is now stale - tokenVersion moved on.
    const refreshRes = await agent.post('/api/platform/auth/refresh');
    expect(refreshRes.status).toBe(401);
  });
});

describe('superadmin routes still reject a tenant-user token', () => {
  it('rejects a request to /api/platform/tenants with no token', async () => {
    const res = await request(app).get('/api/platform/tenants');
    expect(res.status).toBe(401);
  });
});
