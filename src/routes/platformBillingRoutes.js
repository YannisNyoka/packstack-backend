import express, { Router } from 'express';
import * as billingService from '../services/billingService.js';

// No auth here at all, deliberately - PayFast posts directly to this with no
// session/JWT of any kind. Mounted under platformRoutes.js's '/billing'
// *before* its requireSuperAdmin() gate, same reasoning as '/auth' there.
const router = Router();

router.post(
  '/payfast/itn',
  // PayFast posts application/x-www-form-urlencoded, not JSON - app.js's
  // express.json() doesn't parse this content-type, so this route needs its
  // own parser. `verify` captures the exact raw bytes PayFast sent, which
  // billingService forwards to PayFast's own validate endpoint - a parsed-
  // then-reserialized body isn't guaranteed to be byte-identical.
  express.urlencoded({
    extended: false,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
  async (req, res, next) => {
    try {
      await billingService.handlePayfastItn({ orderedFields: Object.entries(req.body), rawBody: req.rawBody });
      // PayFast only checks for a 200 - no specific response body required.
      res.status(200).send('OK');
    } catch (err) {
      next(err);
    }
  }
);

export default router;
