import crypto from 'node:crypto';
import dns from 'node:dns/promises';

const VERIFICATION_SUBDOMAIN = '_packstack-verify';

export function generateVerificationToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function verificationHostFor(domain) {
  return `${VERIFICATION_SUBDOMAIN}.${domain}`;
}

/**
 * Checks that `domain` has a TXT record at _packstack-verify.<domain>
 * containing expectedToken - proof of DNS control without needing to serve
 * anything over HTTP on that domain (which we can't do before the domain is
 * even routed to us). A TXT record's value can arrive split across multiple
 * strings, and a host can have more than one TXT record - each is joined and
 * checked individually rather than assuming a single, whole value.
 *
 * `resolveTxt` is injectable (defaults to the real DNS resolver) purely so
 * tests can stub DNS responses instead of depending on real network/DNS.
 */
export async function domainOwnershipVerified({ domain, expectedToken, resolveTxt = dns.resolveTxt }) {
  let records;
  try {
    records = await resolveTxt(verificationHostFor(domain));
  } catch {
    return false; // NXDOMAIN, no TXT records, timeout, etc. - all just "not verified yet"
  }
  return records.some((chunks) => chunks.join('') === expectedToken);
}
