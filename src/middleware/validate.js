/**
 * Validates req[source] against a zod schema, replacing it with the parsed
 * (and coerced/stripped) value so handlers only ever see known, well-typed
 * fields - this is also the mass-assignment defense: a booking request body
 * can't sneak an extra `tenantId` or `paymentStatus` field into what would
 * otherwise be an innocent create call, because zod's default `.strict()`-free
 * object parsing already drops unrecognized keys when schemas are built with
 * z.object({...}) (no passthrough).
 */
export function validate(schema, source = 'body') {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const err = result.error;
      err.statusCode = 400;
      return next(err);
    }
    req[source] = result.data;
    next();
  };
}
