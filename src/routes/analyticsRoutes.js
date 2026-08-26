import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as analyticsService from '../services/analyticsService.js';

// requireAuth() only, no requireRole('owner') gate - this powers the new
// /dashboard index route (Overview) for every logged-in role, the same way
// AppointmentsPage already shows prices/payment status to staff with no role
// gate. Gating this owner-only would 403 a staff login on their own landing
// page. Revisit as a role-conditional render if revenue visibility for staff
// turns out to be a problem in practice - not something to solve by breaking
// the shared landing page now.
const router = Router({ mergeParams: true });
router.use(requireAuth());

router.get('/overview', async (req, res, next) => {
  try {
    res.json(await analyticsService.getOverview({ tenantId: req.tenant._id }));
  } catch (err) {
    next(err);
  }
});

router.get('/unpaid-appointments', async (req, res, next) => {
  try {
    res.json(await analyticsService.getUnpaidAppointments());
  } catch (err) {
    next(err);
  }
});

const summaryQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d', '1y']).default('30d'),
});

router.get('/summary', validate(summaryQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await analyticsService.getSummary({ tenantId: req.tenant._id, range: req.query.range }));
  } catch (err) {
    next(err);
  }
});

export default router;
