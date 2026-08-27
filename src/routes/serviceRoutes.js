import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as serviceCatalogService from '../services/serviceCatalogService.js';
import * as mediaService from '../services/mediaService.js';
import { ApiError } from '../lib/ApiError.js';

const router = Router({ mergeParams: true });

router.use(requireAuth());

// Empty string clears the image (matches ThemeConfig's logoUrl/bannerUrl
// convention) - a pasted URL and an uploaded-then-Cloudinary-returned URL
// take the same shape either way.
const imageUrlOrEmpty = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/.+/.test(v), 'Must start with http:// or https://');

const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  price: z.number().min(0),
  category: z.string().trim().max(100).optional().default(''),
  imageUrl: imageUrlOrEmpty.optional().default(''),
});

const serviceUpdateSchema = serviceInputSchema.partial();

router.get('/', async (req, res, next) => {
  try {
    const includeInactive = req.auth.role === 'owner' && req.query.includeInactive === 'true';
    res.json(await serviceCatalogService.listServices({ includeInactive }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await serviceCatalogService.getServiceById(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('owner'), validate(serviceInputSchema), async (req, res, next) => {
  try {
    const service = await serviceCatalogService.createService({ req, actorUserId: req.auth.userId, data: req.body });
    res.status(201).json(service);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('owner'), validate(serviceUpdateSchema), async (req, res, next) => {
  try {
    const service = await serviceCatalogService.updateService({
      req,
      actorUserId: req.auth.userId,
      id: req.params.id,
      data: req.body,
    });
    res.json(service);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/active', requireRole('owner'), validate(z.object({ active: z.boolean() })), async (req, res, next) => {
  try {
    const service = await serviceCatalogService.setServiceActive({
      req,
      actorUserId: req.auth.userId,
      id: req.params.id,
      active: req.body.active,
    });
    res.json(service);
  } catch (err) {
    next(err);
  }
});

// Memory storage, same shape as tenantSettingsRoutes.js's theme logo/banner
// upload - the file only ever exists as a Buffer long enough to hand off to
// Cloudinary (mediaService.js).
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

function uploadSingleImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('Image must be smaller than 5MB'));
    next(ApiError.badRequest(err.message || 'Invalid image upload'));
  });
}

router.post('/:id/image', requireRole('owner'), uploadSingleImage, async (req, res, next) => {
  try {
    const service = await mediaService.uploadServiceImage({
      req,
      actorUserId: req.auth.userId,
      tenantId: req.tenant._id,
      serviceId: req.params.id,
      file: req.file,
    });
    res.json(service);
  } catch (err) {
    next(err);
  }
});

export default router;
