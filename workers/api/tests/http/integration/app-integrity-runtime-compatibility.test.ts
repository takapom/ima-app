import { describe, expect, it } from 'vitest';

const SYNTHETIC_SELF_SIGNED_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUeF7z0BRxARAur/0fYinJ5SthIXQwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSbTI3LXJ1bnRpbWUtY2FuYXJ5MB4XDTI2MDkxMDE2MzM0OFoX
DTM2MDkwNzE2MzM0OFowHTEbMBkGA1UEAwwSbTI3LXJ1bnRpbWUtY2FuYXJ5MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz7/ynbAgVNgfS5AwqZfydze3ZP3B7lDB
blqFCJU07veXHeqOzaS4MIRd47Uz6HL0As1fv2Q4qUUCEYeDh4DHP6NTMFEwHQYD
VR0OBBYEFFY+WNSvfc9tUfJHBdDZZIh9yuTYMB8GA1UdIwQYMBaAFFY+WNSvfc9t
UfJHBdDZZIh9yuTYMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIg
UgAI3O8TqaONHyXeAkamY1m+C0/eH5tFqV5MgCprSncCIAWmF+X5kUxpYXshO2aH
NMs26FgA1tKos7oheCY33P88
-----END CERTIFICATE-----`;

describe('M27 App Integrity Worker runtime compatibility', () => {
  it('executes Web Crypto ECDSA P-256 signatures and SHA-256 in workerd', async () => {
    const message = new TextEncoder().encode('m27-runtime-crypto-canary');
    const changedMessage = new TextEncoder().encode('m27-runtime-crypto-canary!');
    const generated = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );

    if (!('privateKey' in generated)) {
      throw new Error('Web Crypto ECDSA did not return a key pair');
    }

    const algorithm = { name: 'ECDSA', hash: 'SHA-256' } as const;
    const signature = await crypto.subtle.sign(algorithm, generated.privateKey, message);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
    const changedDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', changedMessage));

    expect(await crypto.subtle.verify(algorithm, generated.publicKey, signature, message)).toBe(
      true,
    );
    expect(
      await crypto.subtle.verify(algorithm, generated.publicKey, signature, changedMessage),
    ).toBe(false);
    expect(digest).toHaveLength(32);
    expect(changedDigest).not.toEqual(digest);
  });

  it('executes node:crypto X509Certificate APIs only with a synthetic certificate', async () => {
    const { X509Certificate } = await import('node:crypto');
    const certificate = new X509Certificate(SYNTHETIC_SELF_SIGNED_CERTIFICATE);

    expect(certificate.subject).toContain('CN=m27-runtime-canary');
    expect(certificate.raw.byteLength).toBeGreaterThan(0);
    expect(certificate.publicKey).toBeDefined();
    expect(certificate.verify(certificate.publicKey)).toBe(true);

    const publicJwk = certificate.publicKey.export({ format: 'jwk' });
    const importedPublicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(importedPublicKey.type).toBe('public');
    expect(importedPublicKey.algorithm).toMatchObject({
      name: 'ECDSA',
      namedCurve: 'P-256',
    });

    const roundTrip = new X509Certificate(certificate.raw);
    expect(roundTrip.fingerprint256).toBe(certificate.fingerprint256);
  });
});
