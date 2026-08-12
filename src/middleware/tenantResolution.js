import { Tenant } from '../models/Tenant.js';
import { runWithTenant } from '../lib/tenantContext.js';
import { getCachedTenant, setCachedTenant } from '../lib/tenantCache.js';
import { ApiError } from '../lib/ApiError.js';

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

async function resolveTenantBySlug(slug) {
  const cached = getCachedTenant(slug);
  if (cached !== undefined) return cached;

  // Not tenant-scoped - Tenant is what defines a tenant, so this query
  // legitimately runs with no tenant context bound.
  const tenant = await Tenant.findOne({ slug }).lean();
  setCachedTenant(slug, tenant || null);
  return tenant || null;
}

/**
 * Resolves req.params.tenantSlug to a Tenant document, attaches it as
 * req.tenant, and binds the AsyncLocalStorage tenant context for the rest of
 * the request pipeline (every downstream middleware/handler, and every
 * Mongoose query they trigger, runs inside this context). This must be
 * mounted before requireAuth/requireRole and before any route handler.
 */
export function tenantResolution() {
  return async function tenantResolutionMiddleware(req, res, next) {
    try {
      const slug = String(req.params.tenantSlug || '').toLowerCase();
      if (!SLUG_PATTERN.test(slug)) {
        throw ApiError.notFound('Tenant not found');
      }

      const tenant = await resolveTenantBySlug(slug);
      if (!tenant) {
        throw ApiError.notFound('Tenant not found');
      }

      // Suspension itself is enforced by enforceTenantStatus() (mounted
      // right after this middleware) - it needs the request path/method to
      // decide public-vs-dashboard-vs-auth, which isn't available yet here.
      req.tenant = tenant;
      runWithTenant(tenant._id, () => next());
    } catch (err) {
      next(err);
    }
  };
}
