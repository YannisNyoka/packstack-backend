import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireCustomerAuth } from '../middleware/auth.js';
import { rateLimitAuthByIp } from '../middleware/rateLimit.js';
import {
  signUpCustomer,
  loginCustomer,
  refreshCustomerAccessToken,
  logoutAllCustomerSessions,
  toPublicCustomer,
} from '../services/customerAuthService.js';
import { Customer } from '../models/Customer.js';
import { env } from '../config/env.js';
import { ApiError } from '../lib/ApiError.js';

const router = Router({ mergeParams: true });

const REFRESH_COOKIE_NAME = 'ps_customer_refresh';

function refreshCookiePath(tenantSlug) {
  return `/api/t/${tenantSlug}/account/auth`;
}

// Same SameSite reasoning as the matching helper in authRoutes.js /
// platformAuthRoutes.js: the frontend (Vercel) and this API (Render) are
// different sites, so SameSite=Strict would silently never send this cookie
// on the dashboard's cross-site fetch() calls, breaking silent refresh
// entirely. Applying the already-fixed setting here from the start rather
// than rediscovering the same production incident a third time.
function setRefreshCookie(res, tenantSlug, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: refreshCookiePath(tenantSlug),
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

const signupSchema = z.object({
  phone: z.string().min(5),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/signup', rateLimitAuthByIp, validate(signupSchema), async (req, res, next) => {
  try {
    const { phone, name, email, password } = req.body;
    const { customer, accessToken, refreshToken } = await signUpCustomer({
      req,
      tenantId: req.tenant._id,
      phone,
      name,
      email,
      password,
    });
    setRefreshCookie(res, req.params.tenantSlug, refreshToken);
    res.status(201).json({ accessToken, customer });
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  phone: z.string().min(5),
  password: z.string().min(1),
});

router.post('/login', rateLimitAuthByIp, validate(loginSchema), async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const { customer, accessToken, refreshToken } = await loginCustomer({
      req,
      tenantId: req.tenant._id,
      phone,
      password,
    });
    setRefreshCookie(res, req.params.tenantSlug, refreshToken);
    res.json({ accessToken, customer });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', rateLimitAuthByIp, async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) return next(ApiError.unauthorized('No refresh token'));

    const tokens = await refreshCustomerAccessToken({ tenantId: req.tenant._id, refreshToken });
    setRefreshCookie(res, req.params.tenantSlug, tokens.refreshToken);
    res.json({ accessToken: tokens.accessToken });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireCustomerAuth(), async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.customerAuth.customerId);
    if (!customer) throw ApiError.notFound('Account not found');
    res.json(toPublicCustomer(customer));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: refreshCookiePath(req.params.tenantSlug) });
  res.status(204).end();
});

router.post('/logout-all', requireCustomerAuth(), async (req, res, next) => {
  try {
    await logoutAllCustomerSessions({ req, customerId: req.customerAuth.customerId });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: refreshCookiePath(req.params.tenantSlug) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
