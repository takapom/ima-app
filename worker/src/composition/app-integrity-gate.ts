import {
  createAppIntegrityApplication,
  type AppIntegrityOptions,
} from '@worker/application/use-cases/app-integrity/app-integrity';
import {
  createAppIntegrityHttpGate,
  type AppIntegrityGate,
} from '@worker/adapters/in/http/app-integrity-gate';
import { webCryptoNonceGenerator } from '@worker/adapters/out/security/app-integrity-nonce';
export const createAppIntegrityGate = (
  input: Omit<AppIntegrityOptions, 'nonceGenerator'>,
): AppIntegrityGate =>
  createAppIntegrityHttpGate(
    createAppIntegrityApplication({ ...input, nonceGenerator: webCryptoNonceGenerator }),
  );
