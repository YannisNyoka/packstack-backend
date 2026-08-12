import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import * as staffTimeOffService from '../services/staffTimeOffService.js';

// Auth is already applied by the parent staffRoutes router.
const router = Router({ mergeParams: true });

const timeOffQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const timeOffInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  reason: z.string().max(500).optional().default(''),
});

router.get('/', validate(timeOffQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await staffTimeOffService.listTimeOff({ staffMemberId: req.params.staffMemberId, from: req.query.from, to: req.query.to }));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('owner'), validate(timeOffInputSchema), async (req, res, next) => {
  try {
    const timeOff = await staffTimeOffService.createTimeOff({
      req,
      actorUserId: req.auth.userId,
      staffMemberId: req.params.staffMemberId,
      data: req.body,
    });
    res.status(201).json(timeOff);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireRole('owner'), async (req, res, next) => {
  try {
    await staffTimeOffService.deleteTimeOff({
      req,
      actorUserId: req.auth.userId,
      staffMemberId: req.params.staffMemberId,
      id: req.params.id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
