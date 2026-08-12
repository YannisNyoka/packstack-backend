import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { ApiError } from '../lib/ApiError.js';

// Single instance today (Render), so RateLimiterMemory is correct and
// sufficient. If REDIS_URL is set, limiting moves to Redis automatically -
// required once this runs as more than one instance, since in-memory
// counters would silently stop being consistent across instances otherwise.
const redisClient = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  : null;

function makeLimiter(opts) {
  return redisClient
    ? new RateLimiterRedis({ storeClient: redisClient, ...opts })
    : new RateLimiterMemory(opts);
}

// Per-IP: defends against a single abusive client regardless of which
// tenant it's hitting.
const perIpAuthLimiter = makeLimiter({ keyPrefix: 'ip_auth', points: 10, duration: 60 });
const perIpPublicLimiter = makeLimiter({ keyPrefix: 'ip_public', points: 60, duration: 60 });

// Per-tenant: defends every OTHER tenant from one tenant's traffic spike or
// targeted abuse against that specific tenant's booking page.
const perTenantBookingLimiter = makeLimiter({ keyPrefix: 'tenant_booking', points: 30, duration: 60 });

function buildLimitMiddleware(limiter, keyFn) {
  return async function rateLimitMiddleware(req, res, next) {
    // Rate limiting itself isn't what the test suite is testing, and a
    // single test run legitimately creates more auth/booking requests than
    // a real client would in the same window - skip it in test env rather
    // than let it produce flaky, unrelated 429s.
    if (env.NODE_ENV === 'test') return next();

    try {
      await limiter.consume(keyFn(req));
      next();
    } catch {
      next(ApiError.tooManyRequests('Too many requests, please try again shortly.'));
    }
  };
}

export const rateLimitAuthByIp = buildLimitMiddleware(perIpAuthLimiter, (req) => req.ip);
export const rateLimitPublicByIp = buildLimitMiddleware(perIpPublicLimiter, (req) => req.ip);
export const rateLimitBookingByTenant = buildLimitMiddleware(
  perTenantBookingLimiter,
  (req) => String(req.tenant?._id || req.ip)
);
