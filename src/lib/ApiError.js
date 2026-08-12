export class ApiError extends Error {
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || null;
    this.details = details || null;
  }

  static badRequest(message, opts) {
    return new ApiError(400, message, opts);
  }
  static unauthorized(message = 'Unauthorized', opts) {
    return new ApiError(401, message, opts);
  }
  static forbidden(message = 'Forbidden', opts) {
    return new ApiError(403, message, opts);
  }
  static notFound(message = 'Not found', opts) {
    return new ApiError(404, message, opts);
  }
  static conflict(message, opts) {
    return new ApiError(409, message, opts);
  }
  static tooManyRequests(message = 'Too many requests', opts) {
    return new ApiError(429, message, opts);
  }
}
