const REQUEST_TIMEOUT_MS = 8000;

/**
 * Minimal WATI (WhatsApp Business API) client - sends a free-form session
 * message. Unlike Resend, WATI is per-tenant-instance: apiEndpoint is that
 * tenant's own WATI server base URL (e.g. https://live-mt-server.wati.io/12345),
 * so both it and accessToken always come from that tenant's own
 * IntegrationCredential - there is no shared platform WATI account.
 */
export async function sendWhatsAppMessage({ apiEndpoint, accessToken, phone, message }) {
  const url = `${apiEndpoint.replace(/\/+$/, '')}/api/v1/sendSessionMessage/${encodeURIComponent(phone)}?messageText=${encodeURIComponent(message)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WATI request failed (${res.status}): ${body}`);
  }
  return res.json().catch(() => ({}));
}
