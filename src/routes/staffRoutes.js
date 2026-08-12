import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as staffService from '../services/staffService.js';
import staffTimeOffRoutes from './staffTimeOffRoutes.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());

const timeRangeSchema = z.object({ start: z.string(), end: z.string() });
const workingHoursSchema = z
  .object({
    mon: z.array(timeRangeSchema).optional(),
    tue: z.array(timeRangeSchema).optional(),
    wed: z.array(timeRangeSchema).optional(),
    thu: z.array(timeRangeSchema).optional(),
    fri: z.array(timeRangeSchema).optional(),
    sat: z.array(timeRangeSchema).optional(),
    sun: z.array(timeRangeSchema).optional(),
  })
  .optional();

const staffInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  photoUrl: z.string().url().optional().nullable(),
  servicesOffered: z.array(z.string()).optional().default([]),
  workingHours: workingHoursSchema,
});

const staffUpdateSchema = staffInputSchema.partial().extend({ active: z.boolean().optional() });

router.get('/', async (req, res, next) => {
  try {
    const includeInactive = req.auth.role === 'owner' && req.query.includeInactive === 'true';
    res.json(await staffService.listStaff({ includeInactive }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await staffService.getStaffById(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('owner'), validate(staffInputSchema), async (req, res, next) => {
  try {
    const staff = await staffService.createStaffMember({ req, actorUserId: req.auth.userId, data: req.body });
    res.status(201).json(staff);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('owner'), validate(staffUpdateSchema), async (req, res, next) => {
  try {
    const staff = await staffService.updateStaffMember({ req, actorUserId: req.auth.userId, id: req.params.id, data: req.body });
    res.json(staff);
  } catch (err) {
    next(err);
  }
});

router.use('/:staffMemberId/time-off', staffTimeOffRoutes);

export default router;
