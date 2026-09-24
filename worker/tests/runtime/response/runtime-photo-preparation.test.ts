import { describe, expect, it } from 'vitest';
import type { ValidatedMessageResponse } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import {
  prepareRuntimePhotoResolver,
  type RuntimePublicResponseDependencies,
} from '@worker/runtime/response/runtime-response';

const response: ValidatedMessageResponse = {
  presentation: 'keep',
  kind: 'answer',
  message: '写真を含む応答の確定結果',
};

const metadata = {
  threadId: 'thread-photo-preparation',
  turnId: 'turn-photo-preparation',
  responseId: 'response-photo-preparation',
  revision: 2,
};

describe('runtime photo preparation boundary', () => {
  it('withholds only photo tokens when codec or RPC preparation fails', async () => {
    const failures: { readonly code: 'PHOTO_PREPARATION_FAILED' }[] = [];
    const dependencies: RuntimePublicResponseDependencies = {
      textRetention: {
        retentionDecision: 'deny',
        retentionMode: 'session_only',
        sessionExpiresAt: '2026-09-10T13:00:00Z',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only',
        policyStatus: 'policy_withheld',
        displayPolicyStatus: 'policy_withheld',
      },
      preparePhotoTokens: () => Promise.reject(new Error('photo-secret-canary')),
      onPhotoPreparationError: (error) => failures.push(error),
    };

    const resolver = await prepareRuntimePhotoResolver(
      dependencies,
      response,
      metadata,
      '2026-09-10T12:00:00Z',
    );

    expect(resolver).toBeUndefined();
    expect(failures).toEqual([{ code: 'PHOTO_PREPARATION_FAILED' }]);
    expect(JSON.stringify(failures)).not.toContain('photo-secret-canary');

    const observerFailure = await prepareRuntimePhotoResolver(
      {
        ...dependencies,
        onPhotoPreparationError: () => {
          throw new Error('telemetry failure');
        },
      },
      response,
      metadata,
      '2026-09-10T12:00:00Z',
    );
    expect(observerFailure).toBeUndefined();
  });
});
