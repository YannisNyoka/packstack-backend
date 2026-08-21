import { User } from '../models/User.js';
import { SuperAdminUser } from '../models/SuperAdminUser.js';
import { Customer } from '../models/Customer.js';
import { verifyTenantAccessToken, verifySuperAdminAccessToken, verifyCustomerAccessToken } from '../lib/jwt.js';
import { ApiError } from '../lib/ApiError.js';

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Verifies the tenant-user JWT, then re-checks the user's live status and
 * tokenVersion in the DB (rather than trusting the token alone) so a
 * password change or admin-triggered "log out everywhere" takes effect
 * immediately instead of waiting for the token to expire.
 *
 * Must run after tenantResolution() - it explicitly rejects a token whose
 * tenantId doesn't match the tenant resolved from the URL, before ever
 * touching the database. This is the "tampering with the request doesn't
 * help you" guarantee: even if that check were somehow skipped, the
 * tenantScopePlugin would still scope the User.findById below to the URL's
 * tenant and simply find nothing.
 */
export function requireAuth() {
  return async function requireAuthMiddleware(req, res, next) {
    try {
      const token = extractBearerToken(req);
      if (!token) throw ApiError.unauthorized('Missing bearer token');

      let payload;
      try {
        payload = verifyTenantAccessToken(token);
      } catch {
        throw ApiError.unauthorized('Invalid or expired token');
      }

      if (!req.tenant || String(payload.tenantId) !== String(req.tenant._id)) {
        throw ApiError.forbidden('Token does not belong to this tenant', { code: 'TENANT_MISMATCH' });
      }

      // No .select() needed - passwordHash (the only select:false field) isn't
      // read here, and everything else is included by default. See the note
      // in authService.js about why mixing '+field' with plain field names
      // in one .select() call is a trap (it silently drops tenantId too).
      const user = await User.findById(payload.sub);
      if (!user || user.status !== 'active') {
        throw ApiError.unauthorized('Account not found or disabled');
      }
      if (user.tokenVersion !== payload.tokenVersion) {
        throw ApiError.unauthorized('Token has been revoked');
      }

      req.auth = { userId: String(user._id), tenantId: String(req.tenant._id), role: user.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...allowedRoles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(ApiError.forbidden('Insufficient permissions'));
    }
    next();
  };
}

/**
 * Superadmin auth is a fully separate path: different secret
 * (JWT_SUPERADMIN_SECRET), different collection (SuperAdminUser), no
 * tenantResolution() in front of it, no shared code with requireAuth()
 * above. A bug in one cannot become a privilege escalation in the other.
 */
export function requireSuperAdmin() {
  return async function requireSuperAdminMiddleware(req, res, next) {
    try {
      const token = extractBearerToken(req);
      if (!token) throw ApiError.unauthorized('Missing bearer token');

      let payload;
      try {
        payload = verifySuperAdminAccessToken(token);
      } catch {
        throw ApiError.unauthorized('Invalid or expired token');
      }

      const admin = await SuperAdminUser.findById(payload.sub);
      if (!admin || admin.status !== 'active') {
        throw ApiError.unauthorized('Account not found or disabled');
      }
      if (admin.tokenVersion !== payload.tokenVersion) {
        throw ApiError.unauthorized('Token has been revoked');
      }

      req.superAdmin = { userId: String(admin._id) };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same shape as requireAuth() above, for the logged-in customer account
 * surface (see routes/customerAccountRoutes.js). passwordHash being null
 * means this Customer doc exists only from the anonymous booking flow and
 * has never actually signed up - treated the same as "account not found"
 * here, since verifyCustomerAccessToken alone can't tell the two apart.
 */
export function requireCustomerAuth() {
  return async function requireCustomerAuthMiddleware(req, res, next) {
    try {
      const token = extractBearerToken(req);
      if (!token) throw ApiError.unauthorized('Missing bearer token');

      let payload;
      try {
        payload = verifyCustomerAccessToken(token);
      } catch {
        throw ApiError.unauthorized('Invalid or expired token');
      }

      if (!req.tenant || String(payload.tenantId) !== String(req.tenant._id)) {
        throw ApiError.forbidden('Token does not belong to this tenant', { code: 'TENANT_MISMATCH' });
      }

      const customer = await Customer.findById(payload.sub).select('+passwordHash');
      if (!customer || !customer.passwordHash) {
        throw ApiError.unauthorized('Account not found');
      }
      if (customer.tokenVersion !== payload.tokenVersion) {
        throw ApiError.unauthorized('Token has been revoked');
      }

      req.customerAuth = { customerId: String(customer._id), tenantId: String(req.tenant._id) };
      next();
    } catch (err) {
      next(err);
    }
  };
}
