import argon2 from 'argon2';
import { SuperAdminUser } from '../models/SuperAdminUser.js';
import { signSuperAdminAccessToken, signSuperAdminRefreshToken, verifySuperAdminRefreshToken } from '../lib/jwt.js';
import { ApiError } from '../lib/ApiError.js';

// Mirrors services/authService.js's tenant-user login, but against
// SuperAdminUser - a deliberately separate model/collection/code path (see
// middleware/auth.js's requireSuperAdmin()). No logAudit() call here: AuditLog
// is tenant-scoped (tenantScopePlugin) and superadmin routes run with no
// tenant context bound, so there's nothing to scope the entry to yet - same
// gap platformService.provisionTenant() already has.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function issueTokens(admin) {
  const claims = { userId: admin._id, tokenVersion: admin.tokenVersion };
  return {
    accessToken: signSuperAdminAccessToken(claims),
    refreshToken: signSuperAdminRefreshToken(claims),
  };
}

export async function login({ email, password }) {
  const admin = await SuperAdminUser.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  const invalidCredentialsError = () => ApiError.unauthorized('Invalid email or password');
  if (!admin) throw invalidCredentialsError();

  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw ApiError.forbidden('Account temporarily locked due to repeated failed login attempts', { code: 'ACCOUNT_LOCKED' });
  }
  if (admin.status !== 'active') throw ApiError.forbidden('Account disabled');

  const passwordValid = await argon2.verify(admin.passwordHash, password);
  if (!passwordValid) {
    admin.failedLoginAttempts += 1;
    if (admin.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      admin.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
      admin.failedLoginAttempts = 0;
    }
    await admin.save();
    throw invalidCredentialsError();
  }

  admin.failedLoginAttempts = 0;
  admin.lockedUntil = null;
  admin.lastLoginAt = new Date();
  await admin.save();

  return { admin, ...issueTokens(admin) };
}

export async function refreshAccessToken({ refreshToken }) {
  let payload;
  try {
    payload = verifySuperAdminRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const admin = await SuperAdminUser.findById(payload.sub).select('status tokenVersion');
  if (!admin || admin.status !== 'active' || admin.tokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized('Refresh token has been revoked');
  }

  return issueTokens(admin);
}

export async function logoutAllSessions({ userId }) {
  const admin = await SuperAdminUser.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { new: true });
  if (!admin) throw ApiError.notFound('Account not found');
}
