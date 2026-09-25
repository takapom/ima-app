import type { AppIntegrityNonceGenerator } from '@worker/application/ports/app-integrity';
const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

export const webCryptoNonceGenerator: AppIntegrityNonceGenerator = {
  generate: () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  },
};
