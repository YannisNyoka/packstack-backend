import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as domainService from '../services/domainService.js';

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
    res.json(mapping);
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
