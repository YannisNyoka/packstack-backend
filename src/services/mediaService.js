import { env } from '../config/env.js';
import * as cloudinaryClient from '../lib/providers/cloudinaryClient.js';
import * as themeService from './themeService.js';
import { ApiError } from '../lib/ApiError.js';
import { runWithTenant } from '../lib/tenantContext.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function isCloudinaryConfigured() {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/**
 * kind is 'logo' | 'banner' - picks both the ThemeConfig field to update and
 * the Cloudinary publicId (packstack/<tenantId>/<kind>), so a tenant only
 * ever has at most one logo asset and one banner asset regardless of how
 * many times they re-upload.
 */
export async function uploadThemeImage({ req, actorUserId, tenantId, kind, file }) {
  if (!isCloudinaryConfigured()) {
    throw ApiError.badRequest('Image uploads are not configured on this server (CLOUDINARY_* env vars missing)');
  }
  if (!file) throw ApiError.badRequest('No image file was uploaded');
  if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
    throw ApiError.badRequest('Only JPEG, PNG, WebP or GIF images are allowed');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw ApiError.badRequest('Image must be smaller than 5MB');
  }

  let result;
  try {
    result = await cloudinaryClient.uploadImage({
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
      buffer: file.buffer,
      mimetype: file.mimetype,
      publicId: `packstack/${tenantId}/${kind}`,
    });
  } catch (err) {
    throw ApiError.badRequest(`Image upload failed: ${err.message}`);
  }

  const field = kind === 'logo' ? 'logoUrl' : 'bannerUrl';
  // multer's multipart parsing consumes the raw request stream through its
  // own event-driven parser (busboy), whose async resource chain predates
  // tenantResolution.js's runWithTenant() call - AsyncLocalStorage context
  // doesn't reliably survive that boundary, so re-bind it explicitly here
  // rather than relying on ambient context that may already be lost by the
  // time multer hands control back.
  return runWithTenant(tenantId, () =>
    themeService.updateTheme({ req, actorUserId, data: { [field]: result.secure_url } })
  );
}
