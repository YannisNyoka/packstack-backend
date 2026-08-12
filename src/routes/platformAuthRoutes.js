import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { rateLimitAuthByIp } from '../middleware/rateLimit.js';
import { login, refreshAccessToken, logoutAllSessions } from '../services/superAdminAuthService.js';
import { SuperAdminUser } from '../models/SuperAdminUser.js';
import { env } from '../config/env.js';
import { ApiError } from '../lib/ApiError.js';

const router = Router();

const REFRESH_COOKIE_NAME = 'ps_superadmin_refresh';
const REFRESH_COOKIE_PATH = '/api/platform/auth';

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
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
    const { admin, accessToken, refreshToken } = await login({ email, password });
    setRefreshCookie(res, refreshToken);
    res.json({ accessToken, admin: { id: admin._id, email: admin.email } });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', rateLimitAuthByIp, async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) return next(ApiError.unauthorized('No refresh token'));

    const tokens = await refreshAccessToken({ refreshToken });
    setRefreshCookie(res, tokens.refreshToken);
    res.json({ accessToken: tokens.accessToken });
  } catch (err) {
    next(err);
  }
});

// Mirrors authRoutes.js's GET /me - the access token carries only userId/
// tokenVersion (see superAdminAuthService.js#issueTokens), so the console
// needs this to show who's logged in after a page reload re-derives a token
// via silent refresh, the same way the tenant dashboard does.
router.get('/me', requireSuperAdmin(), async (req, res, next) => {
  try {
    const admin = await SuperAdminUser.findById(req.superAdmin.userId).select('email');
    if (!admin) throw ApiError.notFound('Account not found');
    res.json({ id: admin._id, email: admin.email });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  res.status(204).end();
});

router.post('/logout-all', requireSuperAdmin(), async (req, res, next) => {
  try {
    await logoutAllSessions({ userId: req.superAdmin.userId });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
