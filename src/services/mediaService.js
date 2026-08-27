import { env } from '../config/env.js';
import * as cloudinaryClient from '../lib/providers/cloudinaryClient.js';
import * as themeService from './themeService.js';
import * as serviceCatalogService from './serviceCatalogService.js';
import { ApiError } from '../lib/ApiError.js';
import { runWithTenant } from '../lib/tenantContext.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Hero background videos get a much bigger cap than a logo/banner image -
// even a short, low-bitrate clip easily runs several MB.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const ALLOWED_VIDEO_MIMETYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MAX_HERO_VIDEOS = 6;

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

/**
 * A service's photo, shown alongside it in the booking flow and the
 * services list - optional, so services with no image just render without
 * one. Same validation as uploadThemeImage; publicId is keyed by serviceId
 * (not a fixed kind) so each service has at most one image asset regardless
 * of how many times it's re-uploaded.
 */
export async function uploadServiceImage({ req, actorUserId, tenantId, serviceId, file }) {
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
      publicId: `packstack/${tenantId}/services/${serviceId}`,
    });
  } catch (err) {
    throw ApiError.badRequest(`Image upload failed: ${err.message}`);
  }

  // Same AsyncLocalStorage caveat as uploadThemeImage above - re-bind
  // tenant context explicitly rather than relying on it surviving multer's
  // busboy-driven multipart parsing.
  return runWithTenant(tenantId, () =>
    serviceCatalogService.updateService({ req, actorUserId, id: serviceId, data: { imageUrl: result.secure_url } })
  );
}

/**
 * Same shape as uploadThemeImage above, for the landing page hero's video
 * carousel (see ThemeConfig.heroVideoUrls/heroMediaType). Kept as a separate
 * function rather than a branch of uploadThemeImage since the size cap,
 * allowed mimetypes, and Cloudinary resource type all differ. Unlike
 * uploadThemeImage, this appends to a list rather than replacing a single
 * field - each upload gets its own Cloudinary publicId so earlier clips
 * aren't overwritten.
 */
export async function uploadThemeVideo({ req, actorUserId, tenantId, file }) {
  if (!isCloudinaryConfigured()) {
    throw ApiError.badRequest('Video uploads are not configured on this server (CLOUDINARY_* env vars missing)');
  }
  if (!file) throw ApiError.badRequest('No video file was uploaded');
  if (!ALLOWED_VIDEO_MIMETYPES.has(file.mimetype)) {
    throw ApiError.badRequest('Only MP4, WebM or MOV videos are allowed');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw ApiError.badRequest('Video must be smaller than 50MB');
  }

  return runWithTenant(tenantId, async () => {
    const theme = await themeService.getTheme();
    if (theme.heroVideoUrls.length >= MAX_HERO_VIDEOS) {
      throw ApiError.badRequest(`You can have at most ${MAX_HERO_VIDEOS} hero videos - remove one before adding another`);
    }

    let result;
    try {
      result = await cloudinaryClient.uploadVideo({
        cloudName: env.CLOUDINARY_CLOUD_NAME,
        apiKey: env.CLOUDINARY_API_KEY,
        apiSecret: env.CLOUDINARY_API_SECRET,
        buffer: file.buffer,
        mimetype: file.mimetype,
        publicId: `packstack/${tenantId}/hero-video-${Date.now()}`,
      });
    } catch (err) {
      throw ApiError.badRequest(`Video upload failed: ${err.message}`);
    }

    return themeService.updateTheme({
      req,
      actorUserId,
      data: { heroVideoUrls: [...theme.heroVideoUrls, result.secure_url] },
    });
  });
}
