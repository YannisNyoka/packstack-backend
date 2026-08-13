// Loaded via `node --import ./src/instrument.js` (see package.json's
// start/dev scripts) so Sentry's auto-instrumentation wraps express/mongoose
// before anything else in the app has a chance to load - a plain top-level
// import inside server.js can't guarantee that ordering under ESM, since
// imports are hoisted regardless of where the import statement sits in the
// file. Optional: an empty/unset SENTRY_DSN just means Sentry.init() runs as
// a no-op (its own documented behavior), so this is safe to load in every
// environment, including local dev and CI, without needing a dummy DSN.
// Loads .env locally (a no-op if none exists, e.g. on Render where real env
// vars are already injected) - needed because this file runs via --import,
// before config/env.js's own `import 'dotenv/config'` would otherwise fire.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  // This app's request bodies routinely contain real customer PII (name,
  // phone, email - see models/Customer.js) and tenant business data - opt
  // out of sending any of it to Sentry rather than take the default (which
  // sends full request bodies and user info). See
  // https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#dataCollection
  dataCollection: {
    userInfo: false,
    httpBodies: [],
  },
});
