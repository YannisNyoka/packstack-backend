import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Access and refresh tokens (and superadmin tokens) each use a distinct
// secret. This is deliberate: a leaked access-token secret should never be
// enough to mint a refresh token, and a bug in tenant-token verification
// should never be able to validate a superadmin token, because they aren't
// even the same key.

export function signTenantAccessToken({ userId, tenantId, role, tokenVersion }) {
  return jwt.sign({ sub: String(userId), tenantId: String(tenantId), role, tokenVersion }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    audience: 'packstack-tenant',
  });
}

export function signTenantRefreshToken({ userId, tenantId, tokenVersion }) {
  return jwt.sign({ sub: String(userId), tenantId: String(tenantId), tokenVersion }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    audience: 'packstack-tenant',
  });
}

export function verifyTenantAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'packstack-tenant' });
}

export function verifyTenantRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { audience: 'packstack-tenant' });
}

export function signSuperAdminAccessToken({ userId, tokenVersion }) {
  return jwt.sign({ sub: String(userId), role: 'superadmin', tokenVersion }, env.JWT_SUPERADMIN_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    audience: 'packstack-superadmin',
  });
}

export function verifySuperAdminAccessToken(token) {
  return jwt.verify(token, env.JWT_SUPERADMIN_SECRET, { audience: 'packstack-superadmin' });
}

// Superadmin refresh reuses JWT_SUPERADMIN_SECRET (unlike tenant access/refresh,
// which use two distinct secrets) rather than requiring a fourth production
// secret for what's currently a single-operator login. The `audience` claim
// still keeps the two token kinds from being interchangeable - an access
// token presented to verifySuperAdminRefreshToken() fails verification, and
// vice versa. Worth splitting into its own secret if superadmin accounts
// become more than just you.
export function signSuperAdminRefreshToken({ userId, tokenVersion }) {
  return jwt.sign({ sub: String(userId), tokenVersion }, env.JWT_SUPERADMIN_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    audience: 'packstack-superadmin-refresh',
  });
}

export function verifySuperAdminRefreshToken(token) {
  return jwt.verify(token, env.JWT_SUPERADMIN_SECRET, { audience: 'packstack-superadmin-refresh' });
}

// Logged-in customer account tokens (signup/login - see
// customerAuthService.js), distinct from the signed manage-link tokens below:
// this pair identifies a persistent account, not one specific appointment.
// Own secret, same reasoning as every other token family here - a leaked
// customer-token secret must never double as staff/superadmin/manage-link
// access.
export function signCustomerAccessToken({ customerId, tenantId, tokenVersion }) {
  return jwt.sign({ sub: String(customerId), tenantId: String(tenantId), tokenVersion }, env.JWT_CUSTOMER_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    audience: 'packstack-customer',
  });
}

export function verifyCustomerAccessToken(token) {
  return jwt.verify(token, env.JWT_CUSTOMER_SECRET, { audience: 'packstack-customer' });
}

// Refresh reuses JWT_CUSTOMER_SECRET (like superadmin access/refresh above)
// rather than a second secret - the `audience` claim alone already keeps an
// access token from being presented as a refresh token or vice versa.
export function signCustomerRefreshToken({ customerId, tenantId, tokenVersion }) {
  return jwt.sign({ sub: String(customerId), tenantId: String(tenantId), tokenVersion }, env.JWT_CUSTOMER_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    audience: 'packstack-customer-refresh',
  });
}

export function verifyCustomerRefreshToken(token) {
  return jwt.verify(token, env.JWT_CUSTOMER_SECRET, { audience: 'packstack-customer-refresh' });
}

// Password reset link (mailed to the customer, see notificationService.js
// sendPasswordResetEmail). Reuses JWT_CUSTOMER_SECRET rather than a fourth
// dedicated secret - the distinct `audience` claim already keeps it from
// being usable as an access/refresh token even if intercepted, the same
// separation this file already relies on between the customer access and
// refresh pair above. Short-lived, and resetPassword() below additionally
// checks tokenVersion, so completing a reset (or calling logout-all)
// invalidates any other outstanding reset link immediately.
export function signCustomerPasswordResetToken({ customerId, tenantId, tokenVersion }) {
  return jwt.sign({ sub: String(customerId), tenantId: String(tenantId), tokenVersion }, env.JWT_CUSTOMER_SECRET, {
    expiresIn: '30m',
    audience: 'packstack-customer-reset',
  });
}

export function verifyCustomerPasswordResetToken(token) {
  return jwt.verify(token, env.JWT_CUSTOMER_SECRET, { audience: 'packstack-customer-reset' });
}

// Signs the customer-facing "manage your booking" link (view/reschedule/
// cancel with no login - see architecture doc §4). Its own secret, distinct
// from every other token kind here: this one is handed to a customer over
// WhatsApp/email rather than kept server-side like the others, so it must
// never be able to double as an access/refresh/superadmin token even if
// intercepted. expiresAt is the appointment's startTime - the link has no
// reason to work once the appointment it points to has already happened.
export function signAppointmentManageToken({ appointmentId, tenantId, expiresAt }) {
  const secondsUntilExpiry = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return jwt.sign({ sub: String(appointmentId), tenantId: String(tenantId) }, env.APPOINTMENT_LINK_SECRET, {
    audience: 'packstack-appointment-manage',
    expiresIn: secondsUntilExpiry,
  });
}

export function verifyAppointmentManageToken(token) {
  return jwt.verify(token, env.APPOINTMENT_LINK_SECRET, { audience: 'packstack-appointment-manage' });
}
