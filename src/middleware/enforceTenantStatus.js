import { ApiError } from '../lib/ApiError.js';

/**
 * Gates a suspended tenant's access per architecture doc §7: public booking
 * pages become fully unavailable, the staff/owner dashboard goes read-only
 * (GET still works so staff can see why, but nothing can be written), and
 * auth/billing stay open - auth so staff can actually log in to see that
 * read-only state, billing so the owner can still pay and get reactivated
 * rather than being locked out of the one action that fixes this.
 * A trialing/active/past_due tenant is unaffected here - past_due is
 * intentionally invisible to this middleware (dashboard just shows a
 * warning banner, booking keeps working, per the same section).
 *
 * Must run after tenantResolution() (needs req.tenant) and before every
 * sub-router in tenantRouter.js.
 */
export function enforceTenantStatus() {
  return function enforceTenantStatusMiddleware(req, res, next) {
    if (req.tenant.status !== 'suspended') return next();

    if (req.path.startsWith('/auth') || req.path.startsWith('/billing')) return next();

    // '/account' (customer login/signup/self-service) gets the same
    // fully-blocked treatment as '/public' rather than the dashboard's
    // GET-only carve-out below: a suspended tenant already can't take new
    // anonymous bookings, so there's no reason a customer should be able to
    // log in or reschedule/cancel against a business that's currently
    // non-operational.
    if (req.path.startsWith('/public') || req.path.startsWith('/account')) {
      return next(new ApiError(403, 'This business is temporarily unavailable.', { code: 'TENANT_SUSPENDED' }));
    }

    if (req.method === 'GET' || req.method === 'HEAD') return next();

    return next(
      new ApiError(403, 'Your account is suspended - the dashboard is read-only until your subscription is reactivated.', {
        code: 'TENANT_READ_ONLY',
      })
    );
  };
}
