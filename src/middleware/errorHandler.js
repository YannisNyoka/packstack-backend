import * as Sentry from '@sentry/node';
import { ApiError } from '../lib/ApiError.js';
import { TenantScopeViolationError } from '../plugins/tenantScopePlugin.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: 'Not found' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Only the two branches below represent an actual bug (something the
  // codebase itself should never let happen) - ApiError/ZodError/duplicate-
  // key are all routine, expected outcomes of normal request handling
  // (validation failures, conflicts, etc.), not something worth an alert.
  if (err instanceof TenantScopeViolationError) {
    // This should never happen in normal operation - it means a query tried
    // to cross a tenant boundary. Log loudly; never leak internals to the client.
    console.error('TENANT SCOPE VIOLATION:', err.message, { path: req.path, auth: req.auth });
    Sentry.captureException(err);
    return res.status(500).json({ error: { message: 'Internal server error' } });
  }

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      error: { message: err.message, code: err.code, details: err.details },
    });
  }

  if (err?.name === 'ZodError') {
    return res.status(400).json({
      error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: err.flatten?.() ?? err.issues },
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({ error: { message: 'A record with these details already exists', code: 'DUPLICATE' } });
  }

  console.error('Unhandled error:', err);
  Sentry.captureException(err);
  res.status(500).json({ error: { message: 'Internal server error' } });
}
