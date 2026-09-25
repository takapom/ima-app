import {
  AppAttestAssertionSchema,
  AppAttestEnrollRequestSchema,
  AppAttestNonceResponseSchema,
  type AppAttestNonceResponse,
} from '@ima/contracts';
import * as v from 'valibot';
import type {
  AppIntegrityEnforcement,
  AppAttestEnvironment,
  AppIntegrityFailureCode,
  AppIntegrityDecision,
  AppIntegrityOwner,
  AppIntegrityNonce,
} from '@worker/application/ports/app-integrity';
import type { AppIntegrityApplication } from '@worker/application/use-cases/app-integrity/app-integrity';
import { appIntegrityRequestHash } from '@worker/adapters/in/http/app-integrity-request-proof';
export type AppIntegrityRoute =
  | 'conversation_turn'
  | 'search'
  | 'place'
  | 'photos'
  | 'saved_reference_refresh'
  | 'saved_reference_create'
  | 'saved_reference_delete'
  | 'place_decide'
  | 'turn'
  | 'create_thread'
  | 'read_thread'
  | 'replay_thread'
  | 'lifecycle'
  | 'delete_thread'
  | 'events';

export type AppIntegrityGate = {
  readonly enforcement: AppIntegrityEnforcement;
  readonly environment: AppAttestEnvironment;
  readonly issueNonce: (input: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly requestId: string;
    readonly now: string;
  }) => Promise<AppAttestNonceResponse>;
  readonly enroll: (input: {
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly request: unknown;
    readonly now: string;
  }) => Promise<
    | { readonly registered: true }
    | { readonly registered: false; readonly code: AppIntegrityFailureCode }
  >;
  readonly authorize: (input: {
    readonly route: AppIntegrityRoute;
    readonly ownerScopeRef: string;
    readonly deviceId: string;
    readonly request: Request;
    readonly now: string;
    readonly maxBodyBytes: number;
    readonly rawBody?: Uint8Array | undefined;
  }) => Promise<AppIntegrityDecision>;
  readonly revoke: (input: AppIntegrityOwner & { readonly keyId: string }) => Promise<boolean>;
};

const isProtectedRoute = (route: AppIntegrityRoute): boolean =>
  route === 'conversation_turn' ||
  route === 'search' ||
  route === 'place' ||
  route === 'photos' ||
  route === 'saved_reference_refresh' ||
  route === 'turn';

const nonceResponse = (nonce: AppIntegrityNonce, requestId: string): AppAttestNonceResponse => {
  const parsed = v.safeParse(AppAttestNonceResponseSchema, {
    schemaVersion: 'v1',
    requestId,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  if (!parsed.success) throw new Error('APP_ATTEST_NONCE_INVALID');
  return parsed.output;
};

export const createAppIntegrityHttpGate = (
  application: AppIntegrityApplication,
): AppIntegrityGate => ({
  enforcement: application.enforcement,
  environment: application.environment,
  async issueNonce(request) {
    return nonceResponse(await application.issueNonce(request), request.requestId);
  },
  enroll(request) {
    const parsed = v.safeParse(AppAttestEnrollRequestSchema, request.request);
    return application.enroll({
      ownerScopeRef: request.ownerScopeRef,
      deviceId: request.deviceId,
      now: request.now,
      enrollment: parsed.success ? parsed.output : null,
    });
  },
  authorize(request) {
    const keyId = request.request.headers.get('X-App-Attest-KeyId') ?? '';
    const nonce = request.request.headers.get('X-App-Attest-Nonce') ?? '';
    const assertion = request.request.headers.get('X-App-Attest-Assert') ?? '';
    const parsed = v.safeParse(AppAttestAssertionSchema, { keyId, nonce, assertion });
    return application.authorize({
      ownerScopeRef: request.ownerScopeRef,
      deviceId: request.deviceId,
      now: request.now,
      protected: isProtectedRoute(request.route),
      hasAssertion: keyId.length > 0 || nonce.length > 0 || assertion.length > 0,
      assertion: parsed.success ? parsed.output : null,
      proof: {
        hash: () => appIntegrityRequestHash(request.request, request.maxBodyBytes, request.rawBody),
      },
    });
  },
  revoke: (request) => application.revoke(request),
});
export const protectedAppIntegrityRoute = (route: AppIntegrityRoute): boolean =>
  isProtectedRoute(route);
