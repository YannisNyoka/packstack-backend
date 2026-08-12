import { env } from './env.js';
import { DomainMapping } from '../models/DomainMapping.js';

let verifiedDomainsCache = { expiresAt: 0, domains: new Set() };

async function getVerifiedCustomDomains() {
  if (Date.now() < verifiedDomainsCache.expiresAt) return verifiedDomainsCache.domains;

  // Cross-tenant by nature (CORS needs to know about every tenant's verified
  // domain, not just one) - fine to query directly since DomainMapping isn't
  // tenant-scoped (see models/DomainMapping.js).
  const mappings = await DomainMapping.find({ verified: true }).select('domain').lean();
  verifiedDomainsCache = {
    expiresAt: Date.now() + 60_000,
    domains: new Set(mappings.map((m) => m.domain)),
  };
  return verifiedDomainsCache.domains;
}

const subdomainPattern = new RegExp(`^https:\\/\\/[a-z0-9-]+\\.${env.BASE_DOMAIN.replace(/\./g, '\\.')}$`);

export const corsOptions = {
  credentials: true,
  origin: async (origin, callback) => {
    // Non-browser requests (curl, server-to-server webhooks) have no Origin header.
    if (!origin) return callback(null, true);

    if (env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    if (subdomainPattern.test(origin)) return callback(null, true);
    if (env.CORS_EXTRA_ORIGINS.includes(origin)) return callback(null, true);

    try {
      const hostname = new URL(origin).hostname;
      const verified = await getVerifiedCustomDomains();
      if (verified.has(hostname)) return callback(null, true);
    } catch {
      // malformed origin - fall through to rejection
    }

    callback(new Error(`Origin ${origin} not allowed by CORS policy`));
  },
};
