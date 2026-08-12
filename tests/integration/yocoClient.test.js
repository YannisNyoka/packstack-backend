import crypto from 'node:crypto';
import { verifyWebhookSignature } from '../../src/lib/providers/yocoClient.js';

function sign({ webhookId, webhookTimestamp, rawBody, webhookSecret }) {
  const keyBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', keyBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('yocoClient.verifyWebhookSignature', () => {
  const webhookSecret = 'whsec_c2VjcmV0a2V5Zm9ydGVzdGluZzEyMzQ=';
  const webhookId = 'msg_test123';
  const webhookTimestamp = '1700000000';
  const rawBody = JSON.stringify({ type: 'payment.succeeded', payload: { metadata: { checkoutId: 'ch_abc' } } });

  it('accepts a correctly-signed webhook', () => {
    const signatureHeader = sign({ webhookId, webhookTimestamp, rawBody, webhookSecret });
    expect(verifyWebhookSignature({ webhookId, webhookTimestamp, rawBody, signatureHeader, webhookSecret })).toBe(true);
  });

  it('accepts when the correct signature is one of several space-separated candidates (key rotation)', () => {
    const real = sign({ webhookId, webhookTimestamp, rawBody, webhookSecret });
    const signatureHeader = `v1,bm90dGhlcmlnaHRzaWc= ${real}`;
    expect(verifyWebhookSignature({ webhookId, webhookTimestamp, rawBody, signatureHeader, webhookSecret })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signatureHeader = sign({ webhookId, webhookTimestamp, rawBody, webhookSecret });
    const tamperedBody = JSON.stringify({ type: 'payment.succeeded', payload: { metadata: { checkoutId: 'ch_XXX' } } });
    expect(verifyWebhookSignature({ webhookId, webhookTimestamp, rawBody: tamperedBody, signatureHeader, webhookSecret })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const signatureHeader = sign({ webhookId, webhookTimestamp, rawBody, webhookSecret });
    const wrongSecret = 'whsec_d3JvbmdzZWNyZXRrZXkxMjM0NTY3OA==';
    expect(verifyWebhookSignature({ webhookId, webhookTimestamp, rawBody, signatureHeader, webhookSecret: wrongSecret })).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(
      verifyWebhookSignature({ webhookId, webhookTimestamp, rawBody, signatureHeader: undefined, webhookSecret })
    ).toBe(false);
  });
});
