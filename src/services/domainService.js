import { DomainMapping } from '../models/DomainMapping.js';
import { Tenant } from '../models/Tenant.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { getCachedTenant, setCachedTenant, clearTenantCache } from '../lib/tenantCache.js';
import { generateVerificationToken, verificationHostFor, domainOwnershipVerified } from '../lib/dnsVerification.js';

/**
 * Resolves a verified custom domain to its tenant - the domain-based
 * counterpart to tenantResolution.js's slug-based resolveTenantBySlug(), and
 * used the same way: cached (this cache is shared across both key kinds,
 * see lib/tenantCache.js), and treats a suspended tenant as unresolvable.
 * Used by routes/publicDomainRoutes.js so the frontend can turn "I was
 * loaded on this custom domain" into the tenant slug it needs for every
 * other /api/t/:slug/... call - see architecture doc §2.1.
 */
export async function resolveTenantByDomain(domain) {
  const normalizedDomain = String(domain).trim().toLowerCase();
  const cached = getCachedTenant(normalizedDomain);
  if (cached !== undefined) return cached;

  const mapping = await DomainMapping.findOne({ domain: normalizedDomain, verified: true }).lean();
  let tenant = null;
  if (mapping) {
    tenant = await Tenant.findById(mapping.tenantId).select('slug status').lean();
    if (tenant && tenant.status === 'suspended') tenant = null;
  }
  setCachedTenant(normalizedDomain, tenant);
  return tenant;
}

// DomainMapping isn't tenant-scoped (see models/DomainMapping.js) - every
// query in here filters by tenantId explicitly, standing in for what
// tenantScopePlugin would otherwise enforce automatically. Forgetting it on
// any query below would let one tenant see or modify another's domains.

export async function listDomains(tenantId) {
  return DomainMapping.find({ tenantId }).sort({ createdAt: -1 });
}

export async function addDomain({ req, actorUserId, tenantId, domain }) {
  const normalizedDomain = String(domain).trim().toLowerCase();

  const existing = await DomainMapping.findOne({ domain: normalizedDomain });
  if (existing) {
    throw ApiError.conflict(
      String(existing.tenantId) === String(tenantId)
        ? 'This domain has already been added to your account'
        : 'This domain is already claimed by another business',
      { code: 'DOMAIN_TAKEN' }
    );
  }

  const verificationToken = generateVerificationToken();
  const mapping = await DomainMapping.create({ tenantId, domain: normalizedDomain, verificationToken });

  await logAudit({
    req,
    actorUserId,
    action: 'domain.add',
    entityType: 'DomainMapping',
    entityId: mapping._id,
    diff: { after: { domain: normalizedDomain } },
  });

  return {
    domain: mapping.domain,
    verified: mapping.verified,
    sslStatus: mapping.sslStatus,
    dnsInstructions: { type: 'TXT', host: verificationHostFor(mapping.domain), value: verificationToken },
  };
}

export async function verifyDomain({ req, actorUserId, tenantId, domain, resolveTxt }) {
  const mapping = await DomainMapping.findOne({ tenantId, domain }).select('+verificationToken');
  if (!mapping) throw ApiError.notFound('Domain not found');
  if (mapping.verified) return mapping;

  const verified = await domainOwnershipVerified({
    domain: mapping.domain,
    expectedToken: mapping.verificationToken,
    ...(resolveTxt ? { resolveTxt } : {}),
  });

  if (!verified) {
    throw ApiError.badRequest(
      `Could not find the required TXT record at ${verificationHostFor(mapping.domain)}. DNS changes can take a while to propagate - try again shortly.`,
      { code: 'DOMAIN_NOT_VERIFIED' }
    );
  }

  mapping.verified = true;
  await mapping.save();
  clearTenantCache(); // custom-domain resolution and CORS both cache on verified state

  await logAudit({
    req,
    actorUserId,
    action: 'domain.verify',
    entityType: 'DomainMapping',
    entityId: mapping._id,
    diff: { after: { verified: true } },
  });

  return mapping;
}

export async function removeDomain({ req, actorUserId, tenantId, domain }) {
  const mapping = await DomainMapping.findOneAndDelete({ tenantId, domain });
  if (!mapping) throw ApiError.notFound('Domain not found');

  clearTenantCache();

  await logAudit({
    req,
    actorUserId,
    action: 'domain.remove',
    entityType: 'DomainMapping',
    entityId: mapping._id,
    diff: { before: { domain: mapping.domain } },
  });
}
