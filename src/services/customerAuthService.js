import argon2 from 'argon2';
import { Customer } from '../models/Customer.js';
import { signCustomerAccessToken, signCustomerRefreshToken, verifyCustomerRefreshToken } from '../lib/jwt.js';
import { logAudit } from '../lib/auditLog.js';
import { ApiError } from '../lib/ApiError.js';
import { normalizePhone } from '../lib/phone.js';
import { hashPassword } from './authService.js';

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
 * loyaltyPoints, since both key off the same Customer._id.
 */
export async function signUpCustomer({ req, tenantId, phone, name, email, password }) {
  const normalizedPhone = normalizePhone(phone);
  let customer = await Customer.findOne({ phone: normalizedPhone }).select('+passwordHash');

  if (customer?.passwordHash) {
    throw ApiError.conflict('An account with this phone number already exists. Please log in instead.', {
      code: 'ACCOUNT_EXISTS',
    });
  }

  const passwordHash = await hashPassword(password);

  if (customer) {
    customer.passwordHash = passwordHash;
    customer.name = name;
    if (email) customer.email = email;
    await customer.save();
  } else {
    customer = await Customer.create({ phone: normalizedPhone, name, email: email || null, passwordHash });
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

export async function loginCustomer({ req, tenantId, phone, password }) {
  const normalizedPhone = normalizePhone(phone);
  // See the matching comment in authService.js#login - only '+passwordHash'
  // should ever be added to .select() here, since mixing a '+field' with
  // plain field names flips Mongoose into inclusion-only mode and silently
  // drops tenantId, breaking save() on an existing document.
  const customer = await Customer.findOne({ phone: normalizedPhone }).select('+passwordHash');

  // Same generic error whether there's no Customer at all, the Customer has
  // never signed up (passwordHash is null - anonymous-booking-only), or the
  // password is wrong - never leak which phone numbers have accounts.
  const invalidCredentialsError = () => ApiError.unauthorized('Invalid phone number or password');

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
  if (name) customer.name = name;
  if (email !== undefined) customer.email = email || null;
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
