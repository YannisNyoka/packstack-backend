import { Router } from 'express';
import { rateLimitPublicByIp } from '../middleware/rateLimit.js';
import { resolveTenantByDomain } from '../services/domainService.js';
import { ApiError } from '../lib/ApiError.js';

// Unauthenticated, not tenant-resolved (there is no tenant to resolve to
// yet - that's the whole point). The frontend calls this on boot when
// window.location.hostname isn't *.BASE_DOMAIN, to find out which tenant
// slug the rest of its /api/t/:slug/... calls should use.
const router = Router();

router.use(rateLimitPublicByIp);

router.get('/:domain', async (req, res, next) => {
  try {
    const tenant = await resolveTenantByDomain(req.params.domain);
    if (!tenant) throw ApiError.notFound('No business is set up at this domain');
    res.json({ slug: tenant.slug });
  } catch (err) {
    next(err);
  }
});

export default router;
