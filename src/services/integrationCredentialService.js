import { IntegrationCredential } from '../models/IntegrationCredential.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto.js';
import { createWebhookSubscription } from '../lib/providers/yocoClient.js';
import { listDomains } from '../lib/providers/resendClient.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';
import { env } from '../config/env.js';

const PUBLIC_FIELDS = 'provider maskedHint active connectedByUserId createdAt updatedAt';

export async function listCredentials() {
  return IntegrationCredential.find({}).select(PUBLIC_FIELDS).sort({ provider: 1 });
}

/**
 * payload is provider-specific (e.g. wati: { accessToken, apiEndpoint },
 * resend: { apiKey, fromEmail }) - stored as one encrypted JSON blob so each
 * provider can carry whatever fields it needs without a schema change.
 * hintValue is whichever field should drive the masked "•••4471" display.
 */
export async function connectCredential({ req, actorUserId, provider, payload, hintValue }) {
  const encryptedValue = encryptSecret(JSON.stringify(payload));
  const maskedHint = maskSecret(hintValue);

  const credential = await IntegrationCredential.findOneAndUpdate(
    { provider },
    { encryptedValue, maskedHint, active: true, connectedByUserId: actorUserId },
    { upsert: true, new: true, runValidators: true }
  );

  await logAudit({
    req,
    actorUserId,
    action: 'integration.connect',
    entityType: 'IntegrationCredential',
    entityId: credential._id,
    diff: { after: { provider, maskedHint } },
  });

  return { provider: credential.provider, maskedHint: credential.maskedHint, active: credential.active };
}

/**
 * Yoco-specific connect: unlike WATI/Resend (the tenant already has whatever
 * credential they're pasting), a Yoco deposit integration also needs a
 * webhook registered with Yoco itself before it can work - there's no
 * dashboard field for this, it's API-only (Checkout API's own POST
 * /api/webhooks - see lib/providers/yocoClient.js#createWebhookSubscription),
 * and Yoco returns the webhook secret exactly once, in that call's response.
 * One secret key covers both this and checkout creation - confirmed live
 * against Yoco's API. Doing the registration here means the tenant only
 * ever has to paste the one key they already have - never a webhook secret
 * they'd have no ordinary way to obtain themselves.
 */
export async function connectYocoCredential({ req, actorUserId, tenantSlug, secretKey }) {
  let webhook;
  try {
    webhook = await createWebhookSubscription({
      secretKey,
      url: `${env.API_BASE_URL}/api/t/${tenantSlug}/public/deposit-webhook`,
      name: `PackStack deposits - ${tenantSlug}`,
    });
  } catch (err) {
    throw ApiError.badRequest(`Could not connect to Yoco: ${err.message}`);
  }

  return connectCredential({
    req,
    actorUserId,
    provider: 'yoco',
    payload: { secretKey, webhookSecret: webhook.secret },
    hintValue: secretKey,
  });
}

/**
 * Resend-specific connect: unlike a plain API-key credential, a "from"
 * address only actually works once its domain is verified on the tenant's
 * own Resend account (Resend requires DNS proof of ownership - it will
 * never send from an unverifiable consumer domain like gmail.com/
 * outlook.com). Without this check, connecting "succeeds" no matter what
 * fromEmail is given, and every single notification (booking confirmations,
 * password resets, staff invites) then fails silently afterward - caught
 * live via Render logs after exactly that happened for a real tenant who'd
 * entered a gmail.com address. Checking at connect time instead surfaces
 * the real, actionable Resend error immediately.
 */
export async function connectResendCredential({ req, actorUserId, apiKey, fromEmail }) {
  const domain = fromEmail.split('@')[1]?.toLowerCase();

  let domains;
  try {
    domains = await listDomains({ apiKey });
  } catch (err) {
    throw ApiError.badRequest(`Could not connect to Resend: ${err.message}`);
  }

  const match = domains.find((d) => String(d.name).toLowerCase() === domain);
  if (!match || match.status !== 'verified') {
    throw ApiError.badRequest(
      `"${domain}" isn't a verified sending domain on your Resend account yet. Add and verify it at resend.com/domains, then use an email at that domain as your "from" address.`,
      { code: 'DOMAIN_NOT_VERIFIED' }
    );
  }

  return connectCredential({ req, actorUserId, provider: 'resend', payload: { apiKey, fromEmail }, hintValue: apiKey });
}

export async function disconnectCredential({ req, actorUserId, provider }) {
  const credential = await IntegrationCredential.findOneAndUpdate({ provider }, { active: false }, { new: true });
  if (!credential) throw ApiError.notFound('No credential connected for this provider');

  await logAudit({
    req,
    actorUserId,
    action: 'integration.disconnect',
    entityType: 'IntegrationCredential',
    entityId: credential._id,
  });

  return { provider: credential.provider, active: credential.active };
}

/**
 * Internal use only (notificationService etc.) - decrypts and returns the
 * raw provider payload, or null if nothing is connected/active. Never wire
 * this to an API response; the whole point of encryptedValue's select:false
 * is that it's never returned to a client, decrypted or not.
 */
export async function getDecryptedCredential(provider) {
  const credential = await IntegrationCredential.findOne({ provider, active: true }).select('+encryptedValue');
  if (!credential) return null;
  return JSON.parse(decryptSecret(credential.encryptedValue));
}
