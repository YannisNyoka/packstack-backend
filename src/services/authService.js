import argon2 from 'argon2';
import { User } from '../models/User.js';
import { signTenantAccessToken, signTenantRefreshToken, verifyTenantRefreshToken } from '../lib/jwt.js';
import { logAudit } from '../lib/auditLog.js';
import { ApiError } from '../lib/ApiError.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function issueTokens(user, tenantId) {
  const claims = { userId: user._id, tenantId, role: user.role, tokenVersion: user.tokenVersion };
  return {
    accessToken: signTenantAccessToken(claims),
    refreshToken: signTenantRefreshToken(claims),
  };
}

export async function login({ req, tenantId, email, password }) {
  // Only '+passwordHash' is needed here - it's the only field marked
  // select:false in the schema. Listing other, already-included field names
  // alongside a '+' field flips Mongoose's projection to inclusion-only
  // mode, silently dropping every unlisted field (including tenantId) from
  // the loaded document - which then fails required-field validation on
  // save() since tenantId is also immutable and can't be backfilled on an
  // existing (non-new) document.
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  // Same error for "no such user" and "wrong password" - don't leak which
  // emails exist on this tenant.
  const invalidCredentialsError = () => ApiError.unauthorized('Invalid email or password');

  if (!user) throw invalidCredentialsError();

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw ApiError.forbidden('Account temporarily locked due to repeated failed login attempts', { code: 'ACCOUNT_LOCKED' });
  }
  if (user.status !== 'active') throw ApiError.forbidden('Account disabled');

  const passwordValid = await argon2.verify(user.passwordHash, password);
  if (!passwordValid) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    await logAudit({ req, actorUserId: user._id, action: 'auth.login_failed', entityType: 'User', entityId: user._id });
    throw invalidCredentialsError();
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  await logAudit({ req, actorUserId: user._id, action: 'auth.login_success', entityType: 'User', entityId: user._id });

  const tokens = issueTokens(user, tenantId);
  return { user, ...tokens };
}

export async function refreshAccessToken({ tenantId, refreshToken }) {
  let payload;
  try {
    payload = verifyTenantRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  if (String(payload.tenantId) !== String(tenantId)) {
    throw ApiError.forbidden('Refresh token does not belong to this tenant', { code: 'TENANT_MISMATCH' });
  }

  const user = await User.findById(payload.sub).select('role status tokenVersion');
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized('Refresh token has been revoked');
  }

  return issueTokens(user, tenantId);
}

export async function logoutAllSessions({ req, userId }) {
  const user = await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  await logAudit({ req, actorUserId: userId, action: 'auth.logout_all', entityType: 'User', entityId: userId });
}

export async function hashPassword(plaintext) {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}
