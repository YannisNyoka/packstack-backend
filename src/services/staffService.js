import crypto from 'crypto';
import { StaffMember } from '../models/StaffMember.js';
import { Subscription } from '../models/Subscription.js';
import { Plan } from '../models/Plan.js';
import { User } from '../models/User.js';
import { hashPassword } from './authService.js';
import { signStaffInviteToken } from '../lib/jwt.js';
import { sendStaffInviteEmail } from './notificationService.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { env } from '../config/env.js';

const USER_ACCESS_FIELDS = 'email role status';

export async function listStaff({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { active: true };
  return StaffMember.find(filter).sort({ name: 1 }).populate('userId', USER_ACCESS_FIELDS);
}

export async function getStaffById(id) {
  const staff = await StaffMember.findById(id).populate('userId', USER_ACCESS_FIELDS);
  if (!staff) throw ApiError.notFound('Staff member not found');
  return staff;
}

async function assertWithinStaffPlanLimit() {
  const subscription = await Subscription.findOne({});
  if (!subscription) return; // no subscription yet (e.g. trial without one provisioned) - don't block
  const plan = await Plan.findById(subscription.planId);
  if (!plan) return;

  const activeStaffCount = await StaffMember.countDocuments({ active: true });
  if (activeStaffCount >= plan.limits.maxStaff) {
    throw ApiError.forbidden(`Your plan allows up to ${plan.limits.maxStaff} staff members. Upgrade to add more.`, {
      code: 'PLAN_LIMIT_STAFF',
    });
  }
}

export async function createStaffMember({ req, actorUserId, data }) {
  await assertWithinStaffPlanLimit();
  const staff = await StaffMember.create(data);
  await logAudit({ req, actorUserId, action: 'staff.create', entityType: 'StaffMember', entityId: staff._id, diff: { after: data } });
  return staff;
}

export async function updateStaffMember({ req, actorUserId, id, data }) {
  const staff = await getStaffById(id);
  const before = staff.toObject();
  Object.assign(staff, data);
  await staff.save();
  await logAudit({ req, actorUserId, action: 'staff.update', entityType: 'StaffMember', entityId: id, diff: { before, after: data } });
  return staff;
}

function inviteUrlFor(tenant, token) {
  return `https://${tenant.slug}.${env.BASE_DOMAIN}/staff/accept-invite?token=${token}`;
}

async function issueInvite({ req, actorUserId, tenant, staff, user }) {
  const token = signStaffInviteToken({ userId: user._id, tenantId: tenant._id, tokenVersion: user.tokenVersion });
  const inviteUrl = inviteUrlFor(tenant, token);

  await sendStaffInviteEmail({ tenant, email: user.email, name: staff.name, inviteUrl });
  await logAudit({ req, actorUserId, action: 'staff.invite_sent', entityType: 'User', entityId: user._id, diff: { after: { email: user.email } } });

  // Handed back regardless of whether the email above actually went out
  // (Resend may not be connected) - same reasoning as every other
  // best-effort notification in this codebase: the owner can always copy
  // this and share it directly (WhatsApp, in person) rather than being
  // stuck if delivery silently failed.
  return { inviteUrl, email: user.email, status: user.status };
}

/**
 * Grants a StaffMember (a schedulable resource - see StaffMember.js) an
 * actual dashboard login for the first time. Dashboard access itself is
 * nothing new here - role: 'staff' already can't reach Settings/Billing/
 * Integrations/etc (every one of those routes is requireRole('owner')) but
 * can reach Appointments/Analytics/Overview - this only creates the login
 * that role has always implied. passwordHash starts as an unusable random
 * value; acceptStaffInvite() (authService.js) replaces it once the invite
 * link is used.
 */
export async function inviteStaffUser({ req, actorUserId, tenant, staffId, email }) {
  const staff = await getStaffById(staffId);

  if (staff.userId) {
    const hint =
      staff.userId.status === 'invited'
        ? 'Use "Resend invite" instead.'
        : staff.userId.status === 'disabled'
          ? 'Use "Reactivate access" instead - their password from last time still works.'
          : 'They already have dashboard access.';
    throw ApiError.conflict(`This staff member already has a dashboard account. ${hint}`, { code: 'ALREADY_INVITED' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const emailTaken = await User.findOne({ email: normalizedEmail });
  if (emailTaken) {
    throw ApiError.conflict('Another dashboard account already uses this email address.', { code: 'EMAIL_TAKEN' });
  }

  const passwordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
  const user = await User.create({ email: normalizedEmail, passwordHash, role: 'staff', status: 'invited' });

  staff.userId = user._id;
  await staff.save();

  return issueInvite({ req, actorUserId, tenant, staff, user });
}

/**
 * Re-sends the invite link for a StaffMember stuck in 'invited' (the first
 * email may never have arrived, or the 7-day link expired) - regenerates
 * the token rather than reusing the old one, since tokenVersion hasn't
 * changed and the old link would otherwise still be technically valid.
 */
export async function resendStaffInvite({ req, actorUserId, tenant, staffId }) {
  const staff = await getStaffById(staffId);
  if (!staff.userId) throw ApiError.notFound('This staff member has not been invited yet.');

  const user = await User.findById(staff.userId._id ?? staff.userId);
  if (!user || user.status !== 'invited') {
    throw ApiError.badRequest('This staff member already has an active account - nothing to resend.');
  }

  user.tokenVersion += 1; // invalidates whichever earlier link is still outstanding
  await user.save();

  return issueInvite({ req, actorUserId, tenant, staff, user });
}

/**
 * Cancels a pending (never-accepted) invite outright, rather than routing
 * it through revokeStaffAccess's disabled state - an invited account's
 * passwordHash is still the unusable random placeholder from
 * inviteStaffUser(), so "reactivating" it later would leave a login no one
 * can ever get into. Deleting it and clearing the link is what actually
 * lets the owner start a clean new invite instead.
 */
export async function cancelStaffInvite({ req, actorUserId, staffId }) {
  const staff = await getStaffById(staffId);
  if (!staff.userId || staff.userId.status !== 'invited') {
    throw ApiError.badRequest('There is no pending invite to cancel for this staff member.');
  }

  const userId = staff.userId._id;
  staff.userId = null;
  await staff.save();
  await User.deleteOne({ _id: userId });

  await logAudit({ req, actorUserId, action: 'staff.invite_cancelled', entityType: 'User', entityId: userId });
  return { status: null };
}

/**
 * Disables the linked login without deleting it - mirrors
 * integrationCredentialService.js's "disconnect deactivates rather than
 * deletes" pattern. Bumping tokenVersion revokes any session/refresh token
 * immediately rather than waiting for the access token to expire. Only
 * valid once the invite has actually been accepted (status 'active') - an
 * account still stuck at 'invited' has no real password yet, so it's
 * cancelStaffInvite() that applies there instead (see above).
 */
export async function revokeStaffAccess({ req, actorUserId, staffId }) {
  const staff = await getStaffById(staffId);
  if (!staff.userId) throw ApiError.notFound('This staff member has no dashboard access to revoke.');

  const user = await User.findById(staff.userId._id ?? staff.userId);
  if (!user) throw ApiError.notFound('This staff member has no dashboard access to revoke.');
  if (user.status === 'invited') {
    throw ApiError.badRequest('This invite has not been accepted yet - cancel it instead of revoking it.', {
      code: 'INVITE_NOT_ACCEPTED',
    });
  }

  user.status = 'disabled';
  user.tokenVersion += 1;
  await user.save();

  await logAudit({ req, actorUserId, action: 'staff.access_revoked', entityType: 'User', entityId: user._id });
  return { status: user.status };
}

/**
 * Restores a previously-revoked login. No new invite/email round-trip is
 * needed - the account already has a real password from when the invite
 * was first accepted, so this just flips status back to 'active'.
 */
export async function reactivateStaffAccess({ req, actorUserId, staffId }) {
  const staff = await getStaffById(staffId);
  if (!staff.userId) throw ApiError.notFound('This staff member has no dashboard access to reactivate.');

  const user = await User.findById(staff.userId._id ?? staff.userId);
  if (!user || user.status !== 'disabled') {
    throw ApiError.badRequest('This staff member does not have revoked access to reactivate.');
  }

  user.status = 'active';
  await user.save();

  await logAudit({ req, actorUserId, action: 'staff.access_reactivated', entityType: 'User', entityId: user._id });
  return { status: user.status };
}
