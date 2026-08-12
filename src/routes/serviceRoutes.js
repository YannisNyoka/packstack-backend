import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as serviceCatalogService from '../services/serviceCatalogService.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());

const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  price: z.number().min(0),
  category: z.string().trim().max(100).optional().default(''),
});

const serviceUpdateSchema = serviceInputSchema.partial();

router.get('/', async (req, res, next) => {
  try {
    const includeInactive = req.auth.role === 'owner' && req.query.includeInactive === 'true';
    res.json(await serviceCatalogService.listServices({ includeInactive }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await serviceCatalogService.getServiceById(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('owner'), validate(serviceInputSchema), async (req, res, next) => {
  try {
    const service = await serviceCatalogService.createService({ req, actorUserId: req.auth.userId, data: req.body });
    res.status(201).json(service);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('owner'), validate(serviceUpdateSchema), async (req, res, next) => {
  try {
    const service = await serviceCatalogService.updateService({
      req,
      actorUserId: req.auth.userId,
      id: req.params.id,
      data: req.body,
    });
    res.json(service);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/active', requireRole('owner'), validate(z.object({ active: z.boolean() })), async (req, res, next) => {
  try {
    const service = await serviceCatalogService.setServiceActive({
      req,
      actorUserId: req.auth.userId,
      id: req.params.id,
      active: req.body.active,
    });
    res.json(service);
  } catch (err) {
    next(err);
  }
});

export default router;
