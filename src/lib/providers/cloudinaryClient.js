import crypto from 'node:crypto';

const REQUEST_TIMEOUT_MS = 15000;

// Cloudinary signs a request by hashing every param that will be sent
// (except file/api_key/signature/resource_type), sorted alphabetically as
// "key=value&key=value", with the API secret appended directly (no
// separator) - see https://cloudinary.com/documentation/authentication_signatures.
function sign(params, apiSecret) {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');
}

/**
 * Uploads an image buffer to Cloudinary as a signed upload. Uses a plain
 * fetch() against Cloudinary's REST API (like every other provider client in
 * lib/providers/) rather than their SDK, so it stays trivially mockable via
 * jest.spyOn(global, 'fetch') the same way yocoClient/payfastClient are
 * tested - no extra dependency, no SDK-specific mocking setup.
 *
 * overwrite: true against a caller-chosen publicId means re-uploading a
 * tenant's logo/banner replaces the previous asset in place instead of
 * accumulating a new one under a fresh id every time.
 */
export async function uploadImage({ cloudName, apiKey, apiSecret, buffer, mimetype, publicId }) {
  return uploadAsset({ cloudName, apiKey, apiSecret, buffer, mimetype, publicId, resourceType: 'image' });
}

// Hero background videos - same signed-upload flow as uploadImage, just
// posted to Cloudinary's video endpoint instead. resourceType is
// deliberately excluded from the signature (see sign()'s comment above) -
// Cloudinary doesn't include it in what gets hashed.
export async function uploadVideo({ cloudName, apiKey, apiSecret, buffer, mimetype, publicId }) {
  return uploadAsset({ cloudName, apiKey, apiSecret, buffer, mimetype, publicId, resourceType: 'video' });
}

async function uploadAsset({ cloudName, apiKey, apiSecret, buffer, mimetype, publicId, resourceType }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign({ overwrite: true, public_id: publicId, timestamp }, apiSecret);

  const body = new URLSearchParams({
    file: `data:${mimetype};base64,${buffer.toString('base64')}`,
    api_key: apiKey,
    timestamp: String(timestamp),
    signature,
    public_id: publicId,
    overwrite: 'true',
  });

  // Video uploads take meaningfully longer than an image of the same size
  // (Cloudinary transcodes/derives on ingest) - give video 3x the timeout
  // rather than sharing the constant image uploads tune for.
  const timeoutMs = resourceType === 'video' ? REQUEST_TIMEOUT_MS * 3 : REQUEST_TIMEOUT_MS;

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = result?.error?.message || `Cloudinary upload failed (${res.status})`;
    throw new Error(message);
  }
  return result; // { secure_url, public_id, bytes, format, ... }
}
