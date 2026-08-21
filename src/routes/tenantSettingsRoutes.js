import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as tenantSettingsService from '../services/tenantSettingsService.js';
import * as themeService from '../services/themeService.js';
import * as mediaService from '../services/mediaService.js';
import { ApiError } from '../lib/ApiError.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());

const bookingRulesUpdateSchema = z
  .object({
    rescheduleWindowHours: z.number().int().min(0),
    sameDayCutoffTime: z.string().regex(/^\d{2}:\d{2}$/),
    cancellationWindowHours: z.number().int().min(0),
    depositRequired: z.boolean(),
    depositAmountZAR: z.number().min(0),
  })
  .partial();

router.get('/booking-rules', async (req, res, next) => {
  try {
    res.json(await tenantSettingsService.getBookingRules(req.tenant._id));
  } catch (err) {
    next(err);
  }
});

router.patch('/booking-rules', requireRole('owner'), validate(bookingRulesUpdateSchema), async (req, res, next) => {
  try {
    const bookingRules = await tenantSettingsService.updateBookingRules({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      data: req.body,
    });
    res.json(bookingRules);
  } catch (err) {
    next(err);
  }
});

// A hex color like #111827 or the shorthand #fff.
const hexColor = z.string().trim().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex color like #111827');

// logoUrl/bannerUrl/socialLinks are plain URL strings - either whatever
// POST /theme/logo|banner below wrote after a Cloudinary upload, or an
// already-hosted URL the owner pastes in directly. Empty string clears the
// field, matching the model's own defaults.
const urlOrEmpty = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/.+/.test(v), 'Must start with http:// or https://');

const themeUpdateSchema = z
  .object({
    businessName: z.string().trim().min(1).max(200),
    tagline: z.string().trim().max(300),
    logoUrl: urlOrEmpty,
    bannerUrl: urlOrEmpty,
    heroVideoUrl: urlOrEmpty,
    heroMediaType: z.enum(['image', 'video']),
    heroEnabled: z.boolean(),
    heroBadgeText: z.string().trim().max(100),
    colors: z
      .object({
        primary: hexColor,
        secondary: hexColor,
        accent: hexColor,
      })
      .partial(),
    contactInfo: z
      .object({
        phone: z.string().trim().max(50),
        email: z.string().trim().max(200).refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Must be a valid email'),
        address: z.string().trim().max(300),
      })
      .partial(),
    socialLinks: z
      .object({
        instagram: urlOrEmpty,
        facebook: urlOrEmpty,
        whatsapp: z.string().trim().max(50),
        tiktok: urlOrEmpty,
        website: urlOrEmpty,
      })
      .partial(),
  })
  .partial();

router.get('/theme', async (req, res, next) => {
  try {
    res.json(await themeService.getTheme());
  } catch (err) {
    next(err);
  }
});

router.patch('/theme', requireRole('owner'), validate(themeUpdateSchema), async (req, res, next) => {
  try {
    const theme = await themeService.updateTheme({
      req,
      actorUserId: req.auth.userId,
      data: req.body,
    });
    res.json(theme);
  } catch (err) {
    next(err);
  }
});

// Memory storage - the file only ever needs to exist as a Buffer long enough
// to hand off to Cloudinary (mediaService.js), never written to this
// server's disk. Real validation (mimetype allow-list, size cap) happens in
// mediaService.js too; fileFilter here just rejects obviously-wrong types
// before spending time buffering them into memory at all.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP or GIF images are allowed'));
    }
    cb(null, true);
  },
});

// multer reports its own errors (bad mimetype from fileFilter, LIMIT_FILE_SIZE)
// as a plain Error/MulterError, which errorHandler.js would otherwise surface
// as an opaque 500 - normalize to the same ApiError JSON shape as everything else.
function uploadSingleImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('Image must be smaller than 5MB'));
    next(ApiError.badRequest(err.message || 'Invalid image upload'));
  });
}

router.post('/theme/logo', requireRole('owner'), uploadSingleImage, async (req, res, next) => {
  try {
    const theme = await mediaService.uploadThemeImage({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      kind: 'logo',
      file: req.file,
    });
    res.json(theme);
  } catch (err) {
    next(err);
  }
});

router.post('/theme/banner', requireRole('owner'), uploadSingleImage, async (req, res, next) => {
  try {
    const theme = await mediaService.uploadThemeImage({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      kind: 'banner',
      file: req.file,
    });
    res.json(theme);
  } catch (err) {
    next(err);
  }
});

// Separate multer instance from uploadSingleImage above - a hero video needs
// a much larger size cap and a different mimetype allow-list than a
// logo/banner image.
const uploadVideoMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Only MP4, WebM or MOV videos are allowed'));
    }
    cb(null, true);
  },
});

function uploadSingleVideo(req, res, next) {
  uploadVideoMiddleware.single('video')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('Video must be smaller than 50MB'));
    next(ApiError.badRequest(err.message || 'Invalid video upload'));
  });
}

router.post('/theme/hero-video', requireRole('owner'), uploadSingleVideo, async (req, res, next) => {
  try {
    const theme = await mediaService.uploadThemeVideo({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      file: req.file,
    });
    res.json(theme);
  } catch (err) {
    next(err);
  }
});

export default router;
