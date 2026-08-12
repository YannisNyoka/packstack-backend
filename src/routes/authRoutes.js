import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitAuthByIp } from '../middleware/rateLimit.js';
import { login, refreshAccessToken, logoutAllSessions } from '../services/authService.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from '../lib/ApiError.js';

const router = Router({ mergeParams: true });

const REFRESH_COOKIE_NAME = 'ps_refresh';

function refreshCookiePath(tenantSlug) {
  return `/api/t/${tenantSlug}/auth`;
}

function setRefreshCookie(res, tenantSlug, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: refreshCookiePath(tenantSlug),
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', rateLimitAuthByIp, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { user, accessToken, refreshToken } = await login({
      req,
      tenantId: req.tenant._id,
      email,
      password,
    });
    setRefreshCookie(res, req.params.tenantSlug, refreshToken);
    res.json({
      accessToken,
      user: { id: user._id, email: user.email, role: user.role, tenantStatus: req.tenant.status, trialEndsAt: req.tenant.trialEndsAt },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', rateLimitAuthByIp, async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) return next(ApiError.unauthorized('No refresh token'));

    const tokens = await refreshAccessToken({ tenantId: req.tenant._id, refreshToken });
    setRefreshCookie(res, req.params.tenantSlug, tokens.refreshToken);
    res.json({ accessToken: tokens.accessToken });
  } catch (err) {
    next(err);
  }
});

// Refresh only ever returns a new accessToken (see above) - this is what
// lets a page reload restore *who's* logged in (email/role), since the
// frontend never persists that across reloads any more than it persists
// the token itself. req.auth.userId is already verified by requireAuth();
// this just adds the display fields that aren't worth putting in the JWT.
router.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const user = await User.findById(req.auth.userId).select('email role');
    if (!user) throw ApiError.notFound('User not found');
    // tenantStatus/trialEndsAt let the dashboard show a read-only/past-due/
    // trial-countdown banner without every role needing owner-only
    // GET /billing/subscription access.
    res.json({ id: user._id, email: user.email, role: user.role, tenantStatus: req.tenant.status, trialEndsAt: req.tenant.trialEndsAt });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: refreshCookiePath(req.params.tenantSlug) });
  res.status(204).end();
});

router.post('/logout-all', requireAuth(), async (req, res, next) => {
  try {
    await logoutAllSessions({ req, userId: req.auth.userId });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: refreshCookiePath(req.params.tenantSlug) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
