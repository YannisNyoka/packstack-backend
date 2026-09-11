import request from 'supertest';
import { connectTestDB, disconnectTestDB, clearDatabase, buildTestApp } from '../helpers/testApp.js';
import { createTenantWithOwner } from '../helpers/factories.js';
import { runWithTenant } from '../../src/lib/tenantContext.js';
import { StaffMember } from '../../src/models/StaffMember.js';
import { User } from '../../src/models/User.js';

let app;

beforeAll(async () => {
  await connectTestDB();
  app = buildTestApp();
});

afterAll(async () => {
  await disconnectTestDB();
});

const slug = 'staff-access-salon';

describe('Staff dashboard access (invite/accept/resend/revoke/reactivate)', () => {
  let tenant;
  let ownerToken;
  let staffMemberId;

  beforeEach(async () => {
    await clearDatabase();
    const created = await createTenantWithOwner(app, { slug, displayName: 'Staff Access Salon' });
    tenant = created.tenant;
    ownerToken = created.accessToken;

    const staff = await runWithTenant(tenant._id, () => StaffMember.create({ name: 'Jordan Tech' }));
    staffMemberId = String(staff._id);
  });

  it('grants dashboard access without granting Settings access - the login it creates is role: staff', async () => {
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'jordan@example.com', status: 'invited' });
    expect(res.body.inviteUrl).toContain(`${slug}.`);
    expect(res.body.inviteUrl).toContain('/staff/accept-invite?token=');

    const user = await runWithTenant(tenant._id, async () => User.findOne({ email: 'jordan@example.com' }));
    expect(user.role).toBe('staff');
    expect(user.status).toBe('invited');

    const staff = await runWithTenant(tenant._id, async () => StaffMember.findById(staffMemberId));
    expect(String(staff.userId)).toBe(String(user._id));

    // Settings stays owner-only regardless - see integrationRoutes.js /
    // tenantSettingsRoutes.js requireRole('owner') gates, unaffected by this
    // feature. Confirmed once the invite is accepted, below.
  });

  it('409s inviting the same staff member twice rather than creating a second login', async () => {
    await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });

    const secondInvite = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'someone-else@example.com' });
    expect(secondInvite.status).toBe(409);
    expect(secondInvite.body.error.code).toBe('ALREADY_INVITED');
  });

  it('rejects a staff-role account (dashboard access, no Settings) from inviting anyone else to the dashboard', async () => {
    const inviteRes = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });
    const token = new URL(inviteRes.body.inviteUrl).searchParams.get('token');
    const acceptRes = await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token, password: 'a-real-password-123' });
    const staffAccessToken = acceptRes.body.accessToken;

    const otherStaff = await runWithTenant(tenant._id, () => StaffMember.create({ name: 'Someone Else' }));
    const res = await request(app)
      .post(`/api/t/${slug}/staff/${otherStaff._id}/invite`)
      .set('Authorization', `Bearer ${staffAccessToken}`)
      .send({ email: 'someone-else@example.com' });
    expect(res.status).toBe(403);
  });

  it('lets the invited staff member accept the invite, set a password, and log in - but never reach Settings', async () => {
    const inviteRes = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });
    const token = new URL(inviteRes.body.inviteUrl).searchParams.get('token');

    const acceptRes = await request(app)
      .post(`/api/t/${slug}/auth/accept-invite`)
      .send({ token, password: 'a-real-password-123' });

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.user.role).toBe('staff');
    const staffAccessToken = acceptRes.body.accessToken;

    // Dashboard-ish route: open to any authenticated role.
    const appointmentsRes = await request(app)
      .get(`/api/t/${slug}/appointments`)
      .set('Authorization', `Bearer ${staffAccessToken}`);
    expect(appointmentsRes.status).toBe(200);

    // Settings-ish route: owner-only, still blocked for this new login.
    const integrationsRes = await request(app)
      .get(`/api/t/${slug}/integrations`)
      .set('Authorization', `Bearer ${staffAccessToken}`);
    expect(integrationsRes.status).toBe(403);

    // The invite link is single-use - accepting again with the same token fails.
    const secondAccept = await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token, password: 'another-password-1' });
    expect(secondAccept.status).toBe(400);
  });

  it('rejects accepting an invite with a garbage token', async () => {
    const res = await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token: 'not-a-real-token', password: 'a-real-password-123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVITE_TOKEN_INVALID');
  });

  it('resending an invite invalidates the earlier link', async () => {
    const first = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });
    const firstToken = new URL(first.body.inviteUrl).searchParams.get('token');

    const resend = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite/resend`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resend.status).toBe(200);
    const secondToken = new URL(resend.body.inviteUrl).searchParams.get('token');
    expect(secondToken).not.toBe(firstToken);

    const acceptWithOld = await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token: firstToken, password: 'a-real-password-123' });
    expect(acceptWithOld.status).toBe(400);

    const acceptWithNew = await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token: secondToken, password: 'a-real-password-123' });
    expect(acceptWithNew.status).toBe(200);
  });

  it('revoking access blocks login, and reactivating restores it with the same password', async () => {
    const inviteRes = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });
    const token = new URL(inviteRes.body.inviteUrl).searchParams.get('token');
    await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token, password: 'a-real-password-123' });

    const revoke = await request(app)
      .delete(`/api/t/${slug}/staff/${staffMemberId}/access`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe('disabled');

    const blockedLogin = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'jordan@example.com', password: 'a-real-password-123' });
    expect(blockedLogin.status).toBe(403);

    const reactivate = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/access/reactivate`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.status).toBe('active');

    const restoredLogin = await request(app).post(`/api/t/${slug}/auth/login`).send({ email: 'jordan@example.com', password: 'a-real-password-123' });
    expect(restoredLogin.status).toBe(200);
  });

  it('404s revoking or reactivating access for a staff member who was never invited', async () => {
    const revoke = await request(app)
      .delete(`/api/t/${slug}/staff/${staffMemberId}/access`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(revoke.status).toBe(404);

    const reactivate = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/access/reactivate`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(reactivate.status).toBe(404);
  });

  it('rejects revoking a pending (never-accepted) invite - cancelling is the correct action there instead', async () => {
    await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });

    const revoke = await request(app)
      .delete(`/api/t/${slug}/staff/${staffMemberId}/access`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(revoke.status).toBe(400);
    expect(revoke.body.error.code).toBe('INVITE_NOT_ACCEPTED');
  });

  it('cancelling a pending invite deletes the unused login and frees the staff member up for a fresh invite', async () => {
    const firstInvite = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });
    const firstToken = new URL(firstInvite.body.inviteUrl).searchParams.get('token');

    const cancel = await request(app)
      .delete(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(cancel.status).toBe(200);

    const staff = await runWithTenant(tenant._id, async () => StaffMember.findById(staffMemberId));
    expect(staff.userId).toBeNull();

    // The cancelled invite's link no longer works - the User it pointed to is gone.
    const acceptCancelled = await request(app).post(`/api/t/${slug}/auth/accept-invite`).send({ token: firstToken, password: 'a-real-password-123' });
    expect(acceptCancelled.status).toBe(400);

    // Free to invite this staff member again with a brand-new (or the same) email.
    const secondInvite = await request(app)
      .post(`/api/t/${slug}/staff/${staffMemberId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'jordan@example.com' });
    expect(secondInvite.status).toBe(201);
  });
});
