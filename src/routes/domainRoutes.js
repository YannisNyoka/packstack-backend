import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as domainService from '../services/domainService.js';
import { vercelDnsInstructionsFor } from '../lib/providers/vercelClient.js';

const router = Router({ mergeParams: true });

// Custom-domain management changes public DNS-facing routing for the whole
// business - owner only, same bar as integration credentials.
router.use(requireAuth());
router.use(requireRole('owner'));

router.get('/', async (req, res, next) => {
  try {
    res.json(await domainService.listDomains(req.tenant._id));
  } catch (err) {
    next(err);
  }
});

const addDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'Must be a valid domain name'),
});

router.post('/', validate(addDomainSchema), async (req, res, next) => {
  try {
    const result = await domainService.addDomain({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      domain: req.body.domain,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:domain/verify', async (req, res, next) => {
  try {
    const mapping = await domainService.verifyDomain({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      domain: req.params.domain,
    });
    res.json({
      ...mapping.toObject(),
      // TEMP DEBUG - remove after diagnosing the live Vercel-registration issue.
      _debug: {
        hasToken: Boolean(process.env.VERCEL_API_TOKEN),
        hasTeamId: Boolean(process.env.VERCEL_TEAM_ID),
        tokenLen: (process.env.VERCEL_API_TOKEN || '').length,
      },
      // Only relevant once ownership is proven and Vercel registration has
      // been attempted - null once sslStatus is 'issued', nothing left to do.
      vercelDnsInstructions: mapping.verified && mapping.sslStatus !== 'issued' ? vercelDnsInstructionsFor(mapping.domain) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:domain', async (req, res, next) => {
  try {
    await domainService.removeDomain({ req, actorUserId: req.auth.userId, tenantId: req.tenant._id, domain: req.params.domain });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
