import crypto from 'node:crypto';
import { env } from '../../config/env.js';

const REQUEST_TIMEOUT_MS = 8000;

function payfastBaseUrl() {
  return env.PAYFAST_MODE === 'live' ? 'https://www.payfast.co.za' : 'https://sandbox.payfast.co.za';
}

function payfastApiBaseUrl() {
  return env.PAYFAST_MODE === 'live' ? 'https://api.payfast.co.za' : 'https://api.sandbox.payfast.co.za';
}

export function checkoutUrl() {
  return `${payfastBaseUrl()}/eng/process`;
}

// PayFast requires values percent-encoded with spaces as '+' (PHP urlencode
// style), not '%20' - encodeURIComponent then a manual fixup matches that.
function payfastEncode(value) {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

/**
 * Builds the MD5 signature PayFast requires on both outbound checkout
 * requests and inbound ITN payloads: `key=value&...` over the fields in the
 * exact order given, plus the passphrase appended if one is set, MD5-hashed.
 * This function trusts the caller for field order - PayFast's spec is
 * order-sensitive, not alphabetical, so it never sorts.
 */
export function buildSignature(orderedFields, passphrase = '') {
  const pairs = orderedFields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${payfastEncode(String(value))}`);

  if (passphrase) pairs.push(`passphrase=${payfastEncode(passphrase)}`);

  return crypto.createHash('md5').update(pairs.join('&')).digest('hex');
}

/** Recomputes the signature over an ITN payload and compares to what PayFast sent. */
export function verifyItnSignature(orderedFieldsExcludingSignature, providedSignature, passphrase = '') {
  const expected = buildSignature(orderedFieldsExcludingSignature, passphrase);
  return Boolean(providedSignature) && expected === String(providedSignature).toLowerCase();
}

/**
 * PayFast's second recommended ITN check: post the raw ITN body back to
 * PayFast's own server and confirm it echoes back "VALID". This is on top of
 * (not instead of) the signature check above - the signature is the actual
 * cryptographic guarantee (it depends on a shared passphrase never sent over
 * the wire); this call mainly guards against a request that never actually
 * came from PayFast's network at all.
 */
export async function validateWithPayfast(rawBody) {
  const res = await fetch(`${payfastBaseUrl()}/eng/query/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: rawBody,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return text.trim() === 'VALID';
}

/**
 * Headers for PayFast's REST "Subscriptions" API - a separate auth scheme
 * from the MD5 form-post signature above (used for checkout/ITN). This one
 * signs merchant-id/version/timestamp/passphrase as an alphabetically-sorted
 * query string, per PayFast's published API signature scheme. Not yet
 * exercised against a live PayFast sandbox call by this codebase - if
 * cancelSubscription() below comes back "Merchant Authorization Failed",
 * re-check this against a real request/response first.
 */
function buildApiHeaders() {
  const timestamp = new Date().toISOString().split('.')[0];
  const signatureFields = {
    'merchant-id': env.PAYFAST_MERCHANT_ID,
    version: 'v1',
    timestamp,
    passphrase: env.PAYFAST_PASSPHRASE,
  };
  const signatureUri = Object.keys(signatureFields)
    .sort()
    .map((key) => `${key}=${payfastEncode(String(signatureFields[key]))}`)
    .join('&');
  const signature = crypto.createHash('md5').update(signatureUri).digest('hex');

  return {
    'merchant-id': env.PAYFAST_MERCHANT_ID,
    version: 'v1',
    timestamp,
    signature,
    'Content-Type': 'application/json',
  };
}

/** Cancels a PayFast subscription by its token - see billingService.cancelSubscription. */
export async function cancelPayfastSubscription(token) {
  const res = await fetch(`${payfastApiBaseUrl()}/subscriptions/${encodeURIComponent(token)}/cancel`, {
    method: 'PUT',
    headers: buildApiHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PayFast cancel subscription failed (${res.status}): ${body}`);
  }
  return res.json().catch(() => ({}));
}
