# packstack-backend

Multi-tenant API for the PackStack SaaS platform. Phase 1 scope: tenant model,
tenant resolution, auth/RBAC, and the generic salon booking engine (services,
staff, customers, appointments, payments, loyalty) - see
[../packstack/docs/architecture/phase-0-design.md](../packstack/docs/architecture/phase-0-design.md)
for the full architecture this implements.

## Requirements

- Node.js 20+
- A MongoDB instance for local dev (Atlas, or `mongod` running locally)

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `MONGODB_URI` - point at a local/dev database, never a shared/prod one.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_SUPERADMIN_SECRET`, `APPOINTMENT_LINK_SECRET` - each a distinct random secret. Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
  ```
- `SECRETS_MASTER_KEY` - 32 random bytes, base64. Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- `PAYFAST_MERCHANT_ID`/`PAYFAST_MERCHANT_KEY`/`PAYFAST_PASSPHRASE` - optional; only needed to exercise the subscription-billing checkout flow. Leave unset until you have PayFast sandbox credentials - routes that need them fail with a clear error rather than the server refusing to boot.

## Running

```bash
npm run dev     # nodemon, local development
npm start       # production
```

Health check: `GET /healthz`.

## Tenant routing (local dev)

There's no wildcard DNS needed locally. Tenant-scoped routes are addressed by
an explicit slug in the URL path: `http://localhost:4000/api/t/<slug>/...`.
In production this still holds true for the API - the frontend is what maps
`<slug>.packstack.co.za` to API calls against `/api/t/<slug>/...`.

## Creating your first tenant

There's no tenant yet on a fresh database, and tenant creation itself
requires a superadmin account, which also doesn't exist yet. Create one
directly against the database once, then log in and provision tenants
through the API from then on:

```js
// One-time: create a superadmin user directly (e.g. via mongosh or a scratch script)
import { SuperAdminUser } from './src/models/SuperAdminUser.js';
import { hashPassword } from './src/services/authService.js';
await SuperAdminUser.create({ email: 'you@packstack.co.za', passwordHash: await hashPassword('a-strong-password') });
```

Then:

```bash
curl -X POST http://localhost:4000/api/platform/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@packstack.co.za","password":"a-strong-password"}'
# -> { "accessToken": "...", "admin": { "id": "...", "email": "..." } }
# (also sets an httpOnly ps_superadmin_refresh cookie, scoped to /api/platform/auth,
# for POST /api/platform/auth/refresh - see routes/platformAuthRoutes.js)

curl -X POST http://localhost:4000/api/platform/tenants \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"slug":"nxl","displayName":"NXL Beauty Bar","ownerEmail":"owner@nxlbeautybar.co.za","ownerPassword":"a-strong-password-here"}'
```

This creates the `Tenant`, an `owner` `User`, and a default `ThemeConfig`.
Log in as that owner via `POST /api/t/nxl/auth/login`.

## Tests

```bash
npm test
```

`tests/integration/tenantIsolation.test.js` is the important one: it spins up
an in-memory MongoDB (`mongodb-memory-server`, downloads a MongoDB binary on
first run - needs network access once) and asserts, at both the HTTP layer
and directly against Mongoose, that one tenant's data is never reachable from
another tenant's context - by token/URL mismatch, by IDOR (fetching another
tenant's record ID), and by a raw query missing tenant scoping entirely.

## What's deliberately not in Phase 1 yet

- ~~**Customer-facing reschedule/cancel via a signed link**~~ — done: every
  booking confirmation (WhatsApp/email, see above) includes a link signed by
  `signAppointmentManageToken` (`lib/jwt.js`, its own secret -
  `APPOINTMENT_LINK_SECRET`, new required env var - expires at the
  appointment's `startTime`). No-login `GET/PATCH
  /api/t/:slug/public/appointments/manage[/reschedule|/cancel]`
  (`routes/publicRoutes.js`,
  `appointmentService.{getAppointmentByManageToken,rescheduleAppointmentByManageToken,cancelAppointmentByManageToken}`)
  resolve the token to an appointment and always enforce the tenant's
  reschedule/cancellation windows (`bookingRules.isWithinChangeWindow`),
  unlike the staff dashboard's equivalent routes. The link itself points at
  `https://<slug>.<BASE_DOMAIN>/manage?token=...` - `packstack-frontend`'s
  `/manage` route (`pages/ManagePage.jsx`) is now built and wired up, so
  the API side is fully built and tested.
- ~~**Availability/slot computation** for the public booking page~~ — done:
  `GET /api/t/:slug/public/availability?date=YYYY-MM-DD&serviceIds=<id,id>[&staffMemberId=<id>]`
  returns open slots (15-minute grid) per eligible staff member, honoring
  working hours, existing bookings, and the same-day cutoff. See
  `getAvailability` in `src/services/appointmentService.js`.
- ~~**WATI/Resend integration**~~ — done: owner-only credential management at
  `GET/POST/DELETE /api/t/:slug/integrations/{wati,resend}`
  (`routes/integrationRoutes.js`, `services/integrationCredentialService.js`),
  and `services/notificationService.js` sends a booking-confirmation
  WhatsApp message and/or email over whichever channel(s) the tenant has
  connected whenever an appointment is created (public or staff-booked).
  Best-effort by design - a provider outage never fails the booking write.
  Thin REST clients in `lib/providers/{watiClient,resendClient}.js`.
  **Yoco** (each tenant's own end-customer payment rail) is now wired up too
  - see "Yoco deposits" below.
- ~~**Superadmin login route**~~ — done: `POST /api/platform/auth/login`
  (plus `/refresh`, `/logout`, `/logout-all`), mirroring the tenant auth flow
  in `authRoutes.js`/`authService.js` but against `SuperAdminUser`. See
  `routes/platformAuthRoutes.js` / `services/superAdminAuthService.js`. Note
  the refresh token reuses `JWT_SUPERADMIN_SECRET` (distinguished from the
  access token only by its JWT `audience` claim) rather than requiring a
  fourth production secret - worth splitting out if superadmin accounts ever
  become more than just you.
- ~~**PayFast subscription billing**~~ — done: superadmin manages `Plan`s
  (`GET/POST /api/platform/plans`); the tenant owner starts a checkout
  (`POST /api/t/:slug/billing/checkout` with a `planId`, creates/reassigns
  the tenant's one `Subscription` doc and returns signed PayFast hosted-
  checkout fields - `GET .../billing/subscription` reads current status);
  `POST /api/platform/billing/payfast/itn` (unauthenticated - PayFast posts
  directly, mounted ahead of the superadmin gate in `platformRoutes.js`)
  verifies the MD5 signature (`lib/providers/payfastClient.js`), resolves
  the tenant via `custom_str1`, and drives `Subscription.status` through
  `trialing → active → past_due` (`services/billingService.js`). PayFast's
  own server-side ITN validation call runs in production only (skipped in
  dev/test, mirroring the rate-limiter's test-env skip). The `past_due →
  suspended` transition after the 7-day grace period is a separate sweep
  (`expirePastDueSubscriptions`, loops every `Tenant` and binds each one's
  own context - there's no in-process scheduler; run it via
  `npm run billing:expire-past-due` on a daily Render Cron Job).
  §7's subscription-status gating ("public booking page shows unavailable /
  dashboard goes read-only" once suspended) is now built too - see
  "Subscription status enforcement" below.

All of Phase 2 above is now done.

## Phase 3: custom domains

Per §2/§3 of the architecture doc, `DomainMapping` (`domain`, `tenantId`,
`verified`, `sslStatus`) lets a tenant point their own domain
(`nxlbeautybar.co.za`) at PackStack instead of `<slug>.packstack.co.za`.

- **Owner-facing management** (`routes/domainRoutes.js`,
  `services/domainService.js`): `GET/POST /api/t/:slug/domains`,
  `POST /api/t/:slug/domains/:domain/verify`, `DELETE
  /api/t/:slug/domains/:domain`. Adding a domain issues a random
  verification token and a `_packstack-verify.<domain>` TXT record
  instruction (`lib/dnsVerification.js`) - the same DNS-ownership-proof
  pattern Vercel/Netlify use, chosen because it doesn't require serving
  anything over HTTP on a domain we don't control yet.
- **Frontend bootstrap resolution**: `GET /api/public/domains/:domain` -
  unauthenticated, not tenant-resolved (there's no tenant to resolve to
  yet). This is the piece a CSR frontend needs on boot when
  `window.location.hostname` isn't `*.BASE_DOMAIN`: turn the custom domain
  into a tenant slug, then proceed exactly as the subdomain case does for
  every other `/api/t/:slug/...` call. Only resolves domains with
  `verified: true`.
- **Deliberately NOT tenant-scoped**: unlike almost every other model here,
  `DomainMapping` has no `tenantScopePlugin` - see the comment on the model.
  It has to be queryable before any tenant context exists (that's the
  entire point of the lookup above), same reasoning as `Tenant`/`Plan`.
  Every query in `domainService.js` filters by `tenantId` explicitly instead
  - there's no ODM-layer backstop here the way there is elsewhere, so this
  is one of the few places a missing tenant filter would be a real bug
  rather than a caught one. (Tests for exactly that in
  `tests/integration/customDomains.test.js`.)
- **Bug fix along the way**: `config/cors.js` already had logic to accept a
  verified custom domain's `Origin`, using `DomainMapping` under
  `runAsPlatform()`. That combination never actually worked -
  `getCurrentTenantId()` throws for *any* tenant-scoped model query under
  `runAsPlatform()` regardless of the `platform` flag (nothing special-cases
  it), so this would have thrown at runtime the first time a real custom
  domain hit it. Moving `DomainMapping` out of the tenant-scope plugin fixes
  this for free.
- **Not built**: actual TLS/SSL provisioning for a custom domain. `sslStatus`
  is tracked on the model but nothing issues or renews a certificate - that
  happens at the infra layer (e.g. adding the domain in Render's dashboard,
  which handles Let's Encrypt automatically) rather than in this codebase.
  Also not built: the general self-serve DNS-propagation-retry UX (the
  verify endpoint is a single check-now call, not a background poller).

## Beyond Phase 3

Prompted by an audit of NXL Beauty Bar's original standalone system (the
salon this platform's booking engine was generalized from) against what this
generic platform actually supports.

- **Subscription status enforcement**: `middleware/enforceTenantStatus.js`
  (mounted in `tenantRouter.js` right after `tenantResolution()`) implements
  §7 for real. A `suspended` tenant (`Tenant.status`, kept in sync with
  `Subscription.status` by `billingService.js` on every ITN transition and by
  the past-due sweep) gets `/public/*` blocked entirely (`TENANT_SUSPENDED`),
  every other route read-only (GETs pass, writes get `TENANT_READ_ONLY`)
  except `/auth` (staff can still log in) and `/billing` (the owner can still
  pay to get reactivated). `past_due` is intentionally untouched here - banner
  only, booking keeps working, per the same section. `GET/POST /auth/*` now
  return `tenantStatus` so the dashboard can show that banner without an
  owner-only billing call.
- **Staff one-off time off**: `StaffMember.workingHours` is a recurring
  weekly schedule; `StaffTimeOff` (`staffTimeOffService.js`,
  `routes/staffTimeOffRoutes.js`, nested at
  `/api/t/:slug/staff/:staffMemberId/time-off`) layers a one-off exception on
  top - a specific date, optionally a `startTime`/`endTime` range (omitted =
  whole day blocked). `appointmentService.getAvailability` folds these in
  alongside existing bookings when computing open slots.
- **Yoco deposits**: a tenant can require a deposit at booking time, charged
  to the end customer via Yoco's hosted checkout (`lib/providers/yocoClient.js`).
  Requires both `Tenant.bookingRules.{depositRequired,depositAmountZAR}`
  (`GET/PATCH /api/t/:slug/settings/booking-rules`, new
  `routes/tenantSettingsRoutes.js`) and a connected Yoco credential
  (`POST /api/t/:slug/integrations/yoco` with `secretKey` + `webhookSecret` -
  `GET /api/t/:slug/public/deposit-config` reports `required: false` until
  both are true). `POST /api/t/:slug/public/appointments/checkout`
  (`services/depositService.js`) holds the slot as a new `pending_payment`
  Appointment status (occupies the slot like a real booking, no confirmation
  sent yet) and returns a Yoco `redirectUrl`. `POST
  /api/t/:slug/public/deposit-webhook` - Yoco posts here directly, no
  session/JWT, same shape as the PayFast ITN route - verifies the HMAC
  signature (`webhook-id`/`webhook-timestamp`/`webhook-signature` headers,
  the open Standard Webhooks scheme:
  `HMAC-SHA256(whsec_secret, "{id}.{timestamp}.{rawBody}")`, base64), then
  reconciles via `payload.metadata.checkoutId` (Yoco stamps this onto every
  payment webhook itself) against `Payment.providerTransactionId` and
  promotes the appointment to `booked` - only then does the normal booking
  confirmation go out. `npm run deposits:expire-stale`
  (`jobs/expireStalePendingPayments.js`) reclaims slots from abandoned
  checkouts (declined card, closed tab, anything that never resolves via the
  webhook) after 30 minutes - meant to run every few minutes via Render Cron,
  much more frequently than the daily billing sweep.
- **Add-to-calendar link**: small, standalone frontend addition (booking
  confirmation screen builds a Google Calendar deep link) - no backend
  change.
- **Public plans listing**: `GET /api/public/plans`
  (`routes/publicPlansRoutes.js`) - unauthenticated, not tenant-resolved,
  same category as `/api/public/domains`. Returns active `Plan`s
  (`key`/`name`/`priceZAR`/`billingInterval`/`limits`), sorted by price, so
  the separately-hosted marketing site can render real pricing instead of
  hardcoded copy. Requires the marketing site's origin in
  `CORS_EXTRA_ORIGINS` (see `.env.example`) since it's a browser-side fetch
  from a different origin.
- **Branding/theme management**: `ThemeConfig` (logo, banner, colors,
  tagline, contact info, social links) was created at provisioning time and
  read by the public booking page (`GET /api/t/:slug/public/theme`), but had
  no update path at all - every tenant was stuck with just a business name
  and the default colors forever. `GET/PATCH /api/t/:slug/settings/theme`
  (`services/themeService.js`, owner-only for the PATCH, added to the
  existing `tenantSettingsRoutes.js`) closes that. The PATCH merges nested
  groups (`colors`/`contactInfo`/`socialLinks`) field-by-field rather than
  replacing the whole subdocument, so sending just `{ colors: { primary:
  '#fff' } }` doesn't wipe `secondary`/`accent`. `logoUrl`/`bannerUrl` can
  still be set as plain `http(s)://` URL strings directly via the PATCH, or
  uploaded as real image files - see below.
- **Logo/banner image uploads (Cloudinary)**: `POST
  /api/t/:slug/settings/theme/{logo,banner}` (owner-only, `multipart/form-data`,
  field name `image`) accepts a JPEG/PNG/WebP/GIF up to 5MB, uploads it to
  Cloudinary, and writes the resulting `secure_url` onto `ThemeConfig`
  through `themeService.updateTheme` - one call, no separate "confirm the
  URL" step. `lib/providers/cloudinaryClient.js` is a plain `fetch()`
  against Cloudinary's REST API (signed upload, same signing scheme as
  every Cloudinary SDK - see the function's comment) rather than pulling in
  their SDK, so it mocks the same way `yocoClient`/`payfastClient` do in
  tests: `jest.spyOn(global, 'fetch')`, no SDK-specific mocking needed.
  `services/mediaService.js` uses a deterministic Cloudinary `public_id`
  (`packstack/<tenantId>/logo` or `.../banner`) with `overwrite: true`, so
  re-uploading replaces the previous asset instead of accumulating a new one
  under a fresh id every time. Requires `CLOUDINARY_CLOUD_NAME`/
  `CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET` (see `.env.example`) - unset,
  the upload routes fail with a clear 400 rather than the server refusing to
  boot, same pattern as PayFast.
- **Pre-appointment reminders**: booking confirmations (WhatsApp/email) went
  out at booking time, but nothing reminded a customer as their appointment
  approached. `services/reminderService.js`'s `sendDueReminders()` finds
  every `booked`/`confirmed` appointment starting within the next 24 hours
  that hasn't been reminded yet (`Appointment.reminderSentAt`, new field -
  `null` until sent) and fires `notificationService.sendAppointmentReminder`
  over whichever channels the tenant has connected, same best-effort/
  never-throws contract as the booking confirmation. The window is
  deliberately wide (24h) rather than tied to the sweep's own cadence -
  `reminderSentAt` is what actually prevents duplicates, so a job that's
  late or misses a run still catches everyone next time instead of skipping
  them. `npm run reminders:send` (`jobs/sendAppointmentReminders.js`) - meant
  to run roughly hourly via Render Cron, same "loop every tenant, bind its
  own context" shape as the billing and deposit sweeps.
- **Enforced trial length + real pricing**: `Tenant.status` had a `'trial'`
  value from day one, but nothing ever ended one - a tenant with no
  subscription just stayed in `trial` forever. `Tenant.trialEndsAt` (new
  field, set once at provisioning to `createdAt + 30 days` -
  `platformService.TRIAL_LENGTH_DAYS`) plus `billingService.expireTrials()`
  close that: any tenant still in `trial` past its `trialEndsAt` gets
  suspended - same restrictions as an unpaid `past_due` tenant past its
  grace period (`middleware/enforceTenantStatus.js`), no new gating logic
  needed. Tenants with `trialEndsAt: null` (provisioned before this field
  existed) are exempt, not retroactively enforced. `npm run trials:expire`
  (`jobs/expireTrials.js`) - meant to run daily via Render Cron, alongside
  the past-due sweep. `trialEndsAt` is now returned from `POST /auth/login`
  and `GET /auth/me` so `packstack-frontend` can show a countdown.
  Also: the platform's first real `Plan` now exists - `Standard`, R199/month,
  created via the normal superadmin `POST /api/platform/plans` flow (not a
  DB script), so both the marketing site's pricing section and the
  dashboard's billing/checkout flow have real data instead of an empty
  state.
- **Payment visibility in the dashboard**: `paymentRoutes.js`
  (`GET/POST /api/t/:slug/appointments/:appointmentId/payments`) already
  existed - `paymentService.recordPayment` sets `Appointment.paymentStatus`
  (`unpaid`/`paid_cash`/`paid_card`/`paid_online`) and
  `services/depositService.js` already used it for Yoco deposits - but
  nothing in `packstack-frontend` ever called it. The dashboard's
  Appointments page now shows each appointment's payment status as a badge
  and has a "Payments" toggle per row (mirroring the staff time-off pattern)
  that lists recorded payments and lets an owner/staff member log a cash,
  card, or manual payment taken outside of Yoco.
