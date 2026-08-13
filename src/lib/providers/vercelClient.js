import { env } from '../../config/env.js';

const REQUEST_TIMEOUT_MS = 8000;

function vercelConfigured() {
  return Boolean(env.VERCEL_API_TOKEN && env.VERCEL_TEAM_ID);
}

function apiUrl(path) {
  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
  return url.toString();
}

function headers() {
  return { Authorization: `Bearer ${env.VERCEL_API_TOKEN}`, 'Content-Type': 'application/json' };
}

/**
 * Registers a verified custom domain with the packstack-frontend Vercel
 * project, so Vercel actually routes traffic to it and issues an SSL cert -
 * our own DNS-TXT ownership check (dnsVerification.js) only proves the
 * tenant controls the domain, it doesn't make Vercel serve it. Idempotent:
 * re-adding a domain already on this project just returns its current state
 * instead of erroring, so this is safe to call every time verifyDomain()
 * runs (including re-checks of an already-verified domain).
 *
 * Returns null (not an error) if Vercel isn't configured at all, so callers
 * can treat "not configured" the same as "skip this step" rather than
 * needing two different branches.
 */
export async function addDomainToVercelProject(domain) {
  if (!vercelConfigured()) return null;

  const res = await fetch(apiUrl(`/v10/projects/${env.VERCEL_PROJECT_ID}/domains`), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name: domain }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok) return { verified: Boolean(body.verified) };

  // "Already added to this exact project" isn't a failure - re-fetch its
  // current status instead of surfacing the add-conflict as an error.
  if (res.status === 409 || body?.error?.code === 'domain_already_in_use') {
    return getVercelDomainStatus(domain);
  }

  throw new Error(`Vercel domain add failed (${res.status}): ${body?.error?.message || 'unknown error'}`);
}

/** Re-checks whether Vercel now considers a previously-added domain fully configured (DNS actually pointed at it). */
export async function getVercelDomainStatus(domain) {
  if (!vercelConfigured()) return null;

  const res = await fetch(apiUrl(`/v9/projects/${env.VERCEL_PROJECT_ID}/domains/${domain}`), {
    method: 'GET',
    headers: headers(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return { verified: false };
  const body = await res.json().catch(() => ({}));
  return { verified: Boolean(body.verified) };
}

/** Best-effort cleanup when a tenant removes a custom domain - never blocks the removal itself. */
export async function removeDomainFromVercelProject(domain) {
  if (!vercelConfigured()) return;

  await fetch(apiUrl(`/v9/projects/${env.VERCEL_PROJECT_ID}/domains/${domain}`), {
    method: 'DELETE',
    headers: headers(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * The DNS record a tenant needs to point at Vercel for their domain to
 * actually serve traffic - separate from (and in addition to) our own
 * _packstack-verify TXT ownership record. Deliberately returns both options
 * rather than guessing apex-vs-subdomain from the label count: South African
 * .co.za domains (this platform's actual market) have a 3-label apex
 * (mysalon.co.za), which a naive "2 labels = apex" heuristic gets wrong -
 * correctly telling apex from subdomain in general needs a public-suffix
 * list, which isn't worth pulling in for two lines of copy the tenant can
 * trivially disambiguate themselves (they know whether their own domain has
 * a subdomain or not).
 */
export function vercelDnsInstructionsFor(domain) {
  const firstLabel = domain.split('.')[0];
  return {
    apex: { type: 'A', host: '@', value: '76.76.21.21' },
    subdomain: { type: 'CNAME', host: firstLabel, value: 'cname.vercel-dns.com' },
  };
}
