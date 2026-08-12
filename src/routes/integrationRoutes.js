import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as integrationCredentialService from '../services/integrationCredentialService.js';
import { ApiError } from '../lib/ApiError.js';

const router = Router({ mergeParams: true });

// Provider credentials are the keys to a tenant's WhatsApp/email sending
// identity - owner only, no exceptions for staff.
router.use(requireAuth());
router.use(requireRole('owner'));

router.get('/', async (req, res, next) => {
  try {
    res.json(await integrationCredentialService.listCredentials());
  } catch (err) {
    next(err);
  }
});

const watiConnectSchema = z.object({
  accessToken: z.string().min(1),
  apiEndpoint: z.string().url(),
});

router.post('/wati', validate(watiConnectSchema), async (req, res, next) => {
  try {
    const { accessToken, apiEndpoint } = req.body;
    const result = await integrationCredentialService.connectCredential({
      req,
      actorUserId: req.auth.userId,
      provider: 'wati',
      payload: { accessToken, apiEndpoint },
      hintValue: accessToken,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const resendConnectSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.string().email(),
});

router.post('/resend', validate(resendConnectSchema), async (req, res, next) => {
  try {
    const { apiKey, fromEmail } = req.body;
    const result = await integrationCredentialService.connectCredential({
      req,
      actorUserId: req.auth.userId,
      provider: 'resend',
      payload: { apiKey, fromEmail },
      hintValue: apiKey,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const yocoConnectSchema = z.object({
  secretKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});

router.post('/yoco', validate(yocoConnectSchema), async (req, res, next) => {
  try {
    const { secretKey, webhookSecret } = req.body;
    const result = await integrationCredentialService.connectCredential({
      req,
      actorUserId: req.auth.userId,
      provider: 'yoco',
      payload: { secretKey, webhookSecret },
      hintValue: secretKey,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/:provider', async (req, res, next) => {
  try {
    const { provider } = req.params;
    if (!['wati', 'resend', 'yoco'].includes(provider)) {
      throw ApiError.badRequest('Unknown provider');
    }
    const result = await integrationCredentialService.disconnectCredential({
      req,
      actorUserId: req.auth.userId,
      provider,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
