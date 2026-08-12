import crypto from 'node:crypto';

const CHECKOUT_URL = 'https://payments.yoco.com/api/checkouts';
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
