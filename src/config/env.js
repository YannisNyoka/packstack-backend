import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  BASE_DOMAIN: z.string().min(1).default('packstack.co.za'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_SUPERADMIN_SECRET: z.string().min(32, 'JWT_SUPERADMIN_SECRET must be at least 32 chars'),
  JWT_CUSTOMER_SECRET: z.string().min(32, 'JWT_CUSTOMER_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  APPOINTMENT_LINK_SECRET: z.string().min(32, 'APPOINTMENT_LINK_SECRET must be at least 32 chars'),

  // PayFast bills tenants for their PackStack subscription (platform-level
  // billing - not to be confused with Yoco, each tenant's own end-customer
  // payment rail, configured per-tenant via IntegrationCredential instead).
  // Optional, not required, so an environment with billing not yet set up
  // still boots - routes that need it fail with a clear error instead.
  PAYFAST_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYFAST_MERCHANT_ID: z.string().optional(),
  PAYFAST_MERCHANT_KEY: z.string().optional(),
  PAYFAST_PASSPHRASE: z.string().default(''),
  // This server's own public URL, so PayFast's ITN webhook has somewhere to
  // reach back to. Defaults to localhost, which only works with a tunnel
  // (e.g. ngrok) pointed at it for local end-to-end testing against PayFast's
  // sandbox - the ITN route itself works fine locally without one.
  API_BASE_URL: z.string().url().default('http://localhost:4000'),

  SECRETS_MASTER_KEY: z
    .string()
    .min(1, 'SECRETS_MASTER_KEY is required')
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'SECRETS_MASTER_KEY must decode to exactly 32 bytes (base64)'),

  CORS_EXTRA_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  REDIS_URL: z.string().optional(),

  // Powers tenant branding image uploads (theme logo/banner - see
  // services/mediaService.js). Platform-level, not per-tenant like Yoco/WATI
  // credentials - one Cloudinary account holds every tenant's assets, each
  // under its own packstack/<tenantId>/ prefix. Optional, same reasoning as
  // PayFast: an environment with no Cloudinary account yet still boots, and
  // the upload routes fail with a clear error instead.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Lets services/domainService.js register a tenant's verified custom
  // domain with the packstack-frontend Vercel project (see
  // lib/providers/vercelClient.js) - without this, a domain can pass our own
  // DNS-TXT ownership check but never actually get routed/certificated by
  // Vercel. Optional, same reasoning as PayFast/Cloudinary: the domain
  // ownership flow still works without it, just the Vercel-registration step
  // is skipped (logged, not fatal) until these are set.
  VERCEL_API_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().default('packstack-frontend'),
});

function loadEnv() {
  // In test environment, allow a lighter-weight config so the isolation
  // suite doesn't require every production secret to be present locally.
  if (process.env.NODE_ENV === 'test') {
    process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-test-access-secret-32';
    process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-test-refresh-secret';
    process.env.JWT_SUPERADMIN_SECRET ||= 'test-superadmin-secret-test-superadmin';
    process.env.JWT_CUSTOMER_SECRET ||= 'test-customer-secret-test-customer-secret-32';
    process.env.APPOINTMENT_LINK_SECRET ||= 'test-appointment-link-secret-test-32b';
    // PayFast's own published sandbox test credentials - fine to hardcode,
    // they're meant for exactly this.
    process.env.PAYFAST_MERCHANT_ID ||= '10000100';
    process.env.PAYFAST_MERCHANT_KEY ||= '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE ||= 'test-passphrase';
    process.env.SECRETS_MASTER_KEY ||= Buffer.alloc(32, 1).toString('base64');
    process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/packstack_test';
    // Dummy Cloudinary credentials so mediaService's "configured" branch is
    // exercisable by default - tests that need the "not configured" branch
    // blank one of these out on the imported `env` object directly.
    process.env.CLOUDINARY_CLOUD_NAME ||= 'test-cloud';
    process.env.CLOUDINARY_API_KEY ||= 'test-api-key';
    process.env.CLOUDINARY_API_SECRET ||= 'test-api-secret';
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
