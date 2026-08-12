import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with a tenant bound to the async execution context for its
 * entire lifetime (including anything awaited inside it). This is the only
 * way tenantId should ever reach the Mongoose layer — see plugins/tenantScopePlugin.js.
 */
export function runWithTenant(tenantId, fn) {
  return storage.run({ tenantId: String(tenantId) }, fn);
}

/**
 * Runs `fn` in an explicit platform/superadmin context with no tenant bound.
 * Tenant-scoped models will refuse to query without a tenant, so platform-level
 * code that legitimately needs to read across tenants (billing jobs, the
 * superadmin support-access flow) must go through modelsRequiring no scope
 * (Tenant, Plan) or an explicit, audited cross-tenant repository function —
 * never by "faking" a tenant id.
 */
export function runAsPlatform(fn) {
  return storage.run({ tenantId: null, platform: true }, fn);
}

export function getCurrentTenantId({ optional = false } = {}) {
  const store = storage.getStore();
  if (!store || !store.tenantId) {
    if (optional) return null;
    throw new Error(
      'No tenant context bound to this request — refusing to run a tenant-scoped query. ' +
        'This means a tenant-scoped model was queried outside runWithTenant().'
    );
  }
  return store.tenantId;
}

export function hasTenantContext() {
  const store = storage.getStore();
  return Boolean(store && store.tenantId);
}
