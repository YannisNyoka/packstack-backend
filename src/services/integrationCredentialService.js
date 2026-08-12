import { IntegrationCredential } from '../models/IntegrationCredential.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto.js';
import { ApiError } from '../lib/ApiError.js';
import { logAudit } from '../lib/auditLog.js';

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
