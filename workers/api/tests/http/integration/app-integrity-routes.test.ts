import { SELF } from 'cloudflare:test';
import { PublicErrorSchema } from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const headers = (requestId: string): HeadersInit => ({
  'x-app-token': 'test-app-token',
  'x-device-id': 'device-self',
  'x-ima-owner-credential': `${'A'.repeat(42)}E`,
  'x-ima-request-id': requestId,
  'x-app-version': 'c3a-test',
});

describe('M27 App Integrity routes through the Worker entry', () => {
  it('keeps nonce and enrollment fail-closed before verifier composition is injected', async () => {
    const nonce = await SELF.fetch('https://ima.test/v1/attest/nonce', {
      headers: headers('self-nonce'),
    });
    expect(nonce.status).toBe(401);
    expect(v.safeParse(PublicErrorSchema, await nonce.json()).success).toBe(true);

    const enroll = await SELF.fetch('https://ima.test/v1/attest/enroll', {
      method: 'POST',
      headers: { ...headers('self-enroll'), 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: 'self-enroll',
        keyId: 'key-self',
        nonce: 'nonce-self',
        attestation: 'opaque-attestation',
      }),
    });
    expect(enroll.status).toBe(401);
    expect(v.safeParse(PublicErrorSchema, await enroll.json()).success).toBe(true);
  });
});
