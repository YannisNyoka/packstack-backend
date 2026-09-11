import crypto from 'node:crypto';

const CHECKOUT_URL = 'https://payments.yoco.com/api/checkouts';
const WEBHOOK_SUBSCRIPTIONS_URL = 'https://api.yoco.com/v1/webhooks/subscriptions/';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Creates a Yoco hosted checkout for a deposit. amountZAR is rands (what the
 * rest of this codebase uses everywhere, e.g. Plan.priceZAR) - Yoco's API
 * wants cents, so the conversion happens here, once, rather than asking
 * every caller to remember it.
 */
export async function createCheckout({ secretKey, amountZAR, successUrl, cancelUrl, failureUrl, metadata }) {
  const res = await fetch(CHECKOUT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Math.round(amountZAR * 100),
      currency: 'ZAR',
      successUrl,
      cancelUrl,
      failureUrl,
      metadata,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.message || body?.error || `Yoco checkout creation failed (${res.status})`;
    throw new Error(message);
  }
  return body; // { id, redirectUrl, status, amount, currency, metadata, ... }
}

/**
 * Registers a webhook subscription with Yoco (POST /v1/webhooks/subscriptions/,
 * per developer.yoco.com/docs/api/webhooks) so Yoco has somewhere to deliver
 * payment.succeeded events for this tenant's deposit checkouts - there's no
 * dashboard field for this despite what Yoco's own "how to connect" panel
 * implies, it's API-only. Yoco generates and returns a fresh `whsec_...`
 * secret in the response, visible only this once - callers must persist it
 * immediately (see integrationCredentialService.connectYocoCredential).
 */
export async function createWebhookSubscription({ secretKey, notificationUrl, name }) {
  const res = await fetch(WEBHOOK_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_types: ['payment.succeeded'],
      name,
      notification_url: notificationUrl,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.message || body?.error || `Yoco webhook subscription failed (${res.status})`;
    throw new Error(message);
  }
  return body; // { id, secret, notification_url, event_types, ... }
}

/**
 * Verifies a Yoco webhook per the Standard Webhooks spec Yoco implements
 * (https://www.standardwebhooks.com/) - the same scheme Svix-backed
 * providers use. Signed content is `${id}.${timestamp}.${rawBody}`,
 * HMAC-SHA256 over the webhook secret (base64, "whsec_"-prefixed), and the
 * signature header carries one or more space-separated "v1,<base64>"
 * candidates (multiple to support secret rotation) - a match against any one
 * of them is a valid signature.
 *
 * rawBody must be the exact bytes Yoco sent, before any JSON parsing - like
 * PayFast's ITN, re-serializing the parsed body would produce a different
 * byte sequence and always fail verification.
 */
export function verifyWebhookSignature({ webhookId, webhookTimestamp, rawBody, signatureHeader, webhookSecret }) {
  if (!webhookId || !webhookTimestamp || !signatureHeader || !webhookSecret) return false;

  const keyBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', keyBytes).update(signedContent).digest('base64');

  return signatureHeader
    .split(' ')
    .map((candidate) => candidate.split(',')[1])
    .filter(Boolean)
    .some((candidateSig) => {
      const a = Buffer.from(candidateSig);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
}
