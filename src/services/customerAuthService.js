import argon2 from 'argon2';
import { Customer } from '../models/Customer.js';
import {
  signCustomerAccessToken,
  signCustomerRefreshToken,
  verifyCustomerRefreshToken,
  signCustomerPasswordResetToken,
  verifyCustomerPasswordResetToken,
} from '../lib/jwt.js';
import { logAudit } from '../lib/auditLog.js';
import { ApiError } from '../lib/ApiError.js';
import { normalizePhone } from '../lib/phone.js';
import { hashPassword } from './authService.js';
import { sendPasswordResetEmail } from './notificationService.js';
import { env } from '../config/env.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function issueTokens(customer, tenantId) {
  const claims = { customerId: customer._id, tenantId, tokenVersion: customer.tokenVersion };
  return {
    accessToken: signCustomerAccessToken(claims),
    refreshToken: signCustomerRefreshToken(claims),
  };
}

function toPublicCustomer(customer) {
  return {
    id: customer._id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    loyaltyPoints: customer.loyaltyPoints,
  };
}

/**
 * Signup either creates a brand-new Customer or "claims" an existing one
 * created anonymously by the public booking flow (findOrCreateByPhone) - the
 * claim path is what preserves that customer's prior appointment history and
 * loyaltyPoints, since both key off the same Customer._id. Matching for the
 * claim is still done by phone (that's the anonymous flow's own identity
 * key), but the account itself now logs in by email - phone is collected
 * purely as a WhatsApp/notification contact.
 */
export async function signUpCustomer({ req, tenantId, phone, name, email, password }) {
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = email.trim().toLowerCase();

  const existingByPhone = await Customer.findOne({ phone: normalizedPhone }).select('+passwordHash');
  if (existingByPhone?.passwordHash) {
    throw ApiError.conflict('An account with this phone number already exists. Please log in instead.', {
      code: 'ACCOUNT_EXISTS',
    });
  }

  // A different Customer record already sitting on this email (its own
  // anonymous booking's optional email field, or someone else's claimed
  // account) blocks the signup outright, rather than letting it hit the
  // unique index and surface as a raw duplicate-key error.
  const existingByEmail = await Customer.findOne({ email: normalizedEmail });
  if (existingByEmail && String(existingByEmail._id) !== String(existingByPhone?._id)) {
    throw ApiError.conflict('An account with this email already exists. Please log in instead.', {
      code: 'ACCOUNT_EXISTS',
    });
  }

  const passwordHash = await hashPassword(password);
  let customer = existingByPhone;

  if (customer) {
    customer.passwordHash = passwordHash;
    customer.name = name;
    customer.email = normalizedEmail;
    await customer.save();
  } else {
    customer = await Customer.create({ phone: normalizedPhone, name, email: normalizedEmail, passwordHash });
  }

  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customer._id,
    action: 'customer_auth.signup',
    entityType: 'Customer',
    entityId: customer._id,
  });

  const tokens = issueTokens(customer, tenantId);
  return { customer: toPublicCustomer(customer), ...tokens };
}

export async function loginCustomer({ req, tenantId, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  // See the matching comment in authService.js#login - only '+passwordHash'
  // should ever be added to .select() here, since mixing a '+field' with
  // plain field names flips Mongoose into inclusion-only mode and silently
  // drops tenantId, breaking save() on an existing document.
  const customer = await Customer.findOne({ email: normalizedEmail }).select('+passwordHash');

  // Same generic error whether there's no Customer at all, the Customer has
  // never signed up (passwordHash is null - anonymous-booking-only), or the
  // password is wrong - never leak which emails have accounts.
  const invalidCredentialsError = () => ApiError.unauthorized('Invalid email or password');

  if (!customer || !customer.passwordHash) throw invalidCredentialsError();

  if (customer.lockedUntil && customer.lockedUntil > new Date()) {
    throw ApiError.forbidden('Account temporarily locked due to repeated failed login attempts', {
      code: 'ACCOUNT_LOCKED',
    });
  }

  const passwordValid = await argon2.verify(customer.passwordHash, password);
  if (!passwordValid) {
    customer.failedLoginAttempts += 1;
    if (customer.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      customer.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
      customer.failedLoginAttempts = 0;
    }
    await customer.save();
    await logAudit({
      req,
      actorType: 'customer',
      actorCustomerId: customer._id,
      action: 'customer_auth.login_failed',
      entityType: 'Customer',
      entityId: customer._id,
    });
    throw invalidCredentialsError();
  }

  customer.failedLoginAttempts = 0;
  customer.lockedUntil = null;
  customer.lastLoginAt = new Date();
  await customer.save();

  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customer._id,
    action: 'customer_auth.login_success',
    entityType: 'Customer',
    entityId: customer._id,
  });

  const tokens = issueTokens(customer, tenantId);
  return { customer: toPublicCustomer(customer), ...tokens };
}

export async function refreshCustomerAccessToken({ tenantId, refreshToken }) {
  let payload;
  try {
    payload = verifyCustomerRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  if (String(payload.tenantId) !== String(tenantId)) {
    throw ApiError.forbidden('Refresh token does not belong to this tenant', { code: 'TENANT_MISMATCH' });
  }

  const customer = await Customer.findById(payload.sub).select('+passwordHash');
  if (!customer || !customer.passwordHash || customer.tokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized('Refresh token has been revoked');
  }

  return issueTokens(customer, tenantId);
}

export async function logoutAllCustomerSessions({ req, customerId }) {
  const customer = await Customer.findByIdAndUpdate(customerId, { $inc: { tokenVersion: 1 } }, { new: true });
  if (!customer) throw ApiError.notFound('Account not found');
  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customerId,
    action: 'customer_auth.logout_all',
    entityType: 'Customer',
    entityId: customerId,
  });
}

/**
 * Always resolves the same way regardless of whether the email matches an
 * account - the route returns one generic "check your email" response
 * either way, so this never gives a caller a way to enumerate which emails
 * have accounts on this tenant. Delivery itself is best-effort (see
 * sendPasswordResetEmail): if the tenant hasn't connected Resend, the email
 * silently never arrives, same known limitation as booking confirmations.
 */
export async function requestPasswordReset({ req, tenant, email }) {
  const normalizedEmail = email.trim().toLowerCase();
  const customer = await Customer.findOne({ email: normalizedEmail }).select('+passwordHash');
  if (!customer || !customer.passwordHash) return;

  const token = signCustomerPasswordResetToken({
    customerId: customer._id,
    tenantId: tenant._id,
    tokenVersion: customer.tokenVersion,
  });
  const resetUrl = `https://${tenant.slug}.${env.BASE_DOMAIN}/account/reset-password?token=${token}`;

  await sendPasswordResetEmail({ tenant, customer, resetUrl });

  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customer._id,
    action: 'customer_auth.password_reset_requested',
    entityType: 'Customer',
    entityId: customer._id,
  });
}

/**
 * Bumps tokenVersion alongside the password change - unlike
 * changeCustomerPassword (an already-authenticated action), this one just
 * verified nothing but possession of an emailed link, so it also revokes
 * every existing session/refresh-token and, as a side effect, the reset
 * token itself (its tokenVersion claim no longer matches).
 */
export async function resetPassword({ req, tenantId, token, newPassword }) {
  let payload;
  try {
    payload = verifyCustomerPasswordResetToken(token);
  } catch {
    throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.', {
      code: 'RESET_TOKEN_INVALID',
    });
  }

  if (String(payload.tenantId) !== String(tenantId)) {
    throw ApiError.forbidden('Reset token does not belong to this tenant', { code: 'TENANT_MISMATCH' });
  }

  const customer = await Customer.findById(payload.sub).select('+passwordHash');
  if (!customer || !customer.passwordHash || customer.tokenVersion !== payload.tokenVersion) {
    throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.', {
      code: 'RESET_TOKEN_INVALID',
    });
  }

  customer.passwordHash = await hashPassword(newPassword);
  customer.tokenVersion += 1;
  customer.failedLoginAttempts = 0;
  customer.lockedUntil = null;
  await customer.save();

  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customer._id,
    action: 'customer_auth.password_reset',
    entityType: 'Customer',
    entityId: customer._id,
  });

  const tokens = issueTokens(customer, tenantId);
  return { customer: toPublicCustomer(customer), ...tokens };
}

export async function changeCustomerPassword({ req, customerId, currentPassword, newPassword }) {
  const customer = await Customer.findById(customerId).select('+passwordHash');
  if (!customer || !customer.passwordHash) throw ApiError.notFound('Account not found');

  const currentValid = await argon2.verify(customer.passwordHash, currentPassword);
  if (!currentValid) throw ApiError.badRequest('Current password is incorrect');

  customer.passwordHash = await hashPassword(newPassword);
  await customer.save();

  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customerId,
    action: 'customer_auth.password_changed',
    entityType: 'Customer',
    entityId: customerId,
  });
}

export async function updateOwnProfile({ req, customerId, name, email }) {
  const customer = await Customer.findById(customerId);
  if (!customer) throw ApiError.notFound('Account not found');

  const before = { name: customer.name, email: customer.email };

  if (email !== undefined) {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail !== customer.email) {
      const emailTaken = await Customer.findOne({ email: normalizedEmail });
      if (emailTaken) throw ApiError.conflict('That email is already in use by another account.', { code: 'EMAIL_TAKEN' });
      customer.email = normalizedEmail;
    }
  }
  if (name) customer.name = name;
  await customer.save();

  await logAudit({
    req,
    actorType: 'customer',
    actorCustomerId: customerId,
    action: 'customer_auth.profile_updated',
    entityType: 'Customer',
    entityId: customerId,
    diff: { before, after: { name: customer.name, email: customer.email } },
  });

  return toPublicCustomer(customer);
}

export { toPublicCustomer };
