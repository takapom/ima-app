import { describe, expect, it } from 'vitest';
import type { ProviderRecordIdentity } from '@worker/core/domain/candidates/registry';
import type { RetentionMetadata } from '@worker/core/domain/evidence/retention';
import type { EvidenceLink } from '@worker/core/application/use-cases/submit-response/validation/submit-cards-evidence';
import { isHotPepperPhotoIdentity } from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reference';
import { committedConversationPhotoSources } from '@worker/infrastructure/runtime/conversations/conversation-photo-sources';

const retention = {
  retentionDecision: 'allow',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-22T11:00:00Z',
  freshUntil: '2026-09-22T10:00:00Z',
  displayUntil: '2026-09-22T11:00:00Z',
  retentionUntil: '2026-09-22T11:00:00Z',
  deletionScheduledAt: '2026-09-22T11:00:00Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const link = (
  identity: ProviderRecordIdentity,
  patch: Partial<EvidenceLink> = {},
): EvidenceLink => ({
  observationId: 'obs',
  candidateId: 'shop',
  field: 'identity',
  sources: [{ ...identity, attribution: null, publicUrl: null }],
  retention,
  ...patch,
});

const response = (evidenceIds: readonly string[] = ['obs']) => ({
  presentation: 'replace' as const,
  hero: { candidateId: 'shop', evidenceIds },
  alts: [],
});

const resolve =
  (links: Record<string, EvidenceLink | undefined>) => (candidateId: string, evidenceId: string) =>
    candidateId === 'shop' ? links[evidenceId] : undefined;

describe('photo references from validated evidence', () => {
  it('keeps one accepted shop identity and merges the same pair', () => {
    const identity = { provider: 'hotpepper', recordRef: 'J123' };
    const sources = committedConversationPhotoSources(
      response(['one', 'two']),
      resolve({ one: link(identity), two: link(identity) }),
      isHotPepperPhotoIdentity,
    );
    expect(sources).toEqual([{ candidateId: 'shop', ...identity }]);
  });

  it('does not pick one shop when accepted identities disagree', () => {
    const sources = committedConversationPhotoSources(
      response(['one', 'two']),
      resolve({
        one: link({ provider: 'hotpepper', recordRef: 'J123' }),
        two: link({ provider: 'hotpepper', recordRef: 'J999' }),
      }),
      isHotPepperPhotoIdentity,
    );
    expect(sources).toEqual([]);
  });

  it('treats the same record ref at different providers as different shops', () => {
    const accepts = (identity: ProviderRecordIdentity) =>
      identity.recordRef === 'shop-1' &&
      (identity.provider === 'hotpepper' || identity.provider === 'example');
    const sources = committedConversationPhotoSources(
      response(['one', 'two']),
      resolve({
        one: link({ provider: 'hotpepper', recordRef: 'shop-1' }),
        two: link({ provider: 'example', recordRef: 'shop-1' }),
      }),
      accepts,
    );
    expect(sources).toEqual([]);
  });

  it('does not adopt evidence the connected provider rejects, a denied save, or a missing link', () => {
    expect(
      committedConversationPhotoSources(
        response(),
        resolve({ obs: link({ provider: 'example', recordRef: 'shop-1' }) }),
        isHotPepperPhotoIdentity,
      ),
    ).toEqual([]);
    expect(
      committedConversationPhotoSources(
        response(),
        resolve({
          obs: link(
            { provider: 'hotpepper', recordRef: 'J123' },
            {
              retention: {
                ...retention,
                retentionDecision: 'deny',
                retentionUntil: null,
                deletionScheduledAt: null,
                restoreMode: 'unavailable',
                policyStatus: 'policy_withheld',
              },
            },
          ),
        }),
        isHotPepperPhotoIdentity,
      ),
    ).toEqual([]);
    expect(
      committedConversationPhotoSources(response(), resolve({}), isHotPepperPhotoIdentity),
    ).toEqual([]);
    expect(
      committedConversationPhotoSources(
        { presentation: 'keep' },
        resolve({ obs: link({ provider: 'hotpepper', recordRef: 'J123' }) }),
        isHotPepperPhotoIdentity,
      ),
    ).toEqual([]);
  });

  it('does not turn a canonical shop url on the evidence into a shop id', () => {
    const sources = committedConversationPhotoSources(
      response(),
      resolve({
        obs: link(
          { provider: 'hotpepper', recordRef: 'not-an-id' },
          {
            sources: [
              {
                provider: 'hotpepper',
                recordRef: 'not-an-id',
                attribution: null,
                publicUrl: 'https://www.hotpepper.jp/strJ123/',
              },
            ],
          },
        ),
      }),
      isHotPepperPhotoIdentity,
    );
    expect(sources).toEqual([]);
  });
});
