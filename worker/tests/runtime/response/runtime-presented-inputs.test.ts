import { describe, expect, it } from 'vitest';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import { createPresentedInputs } from '@worker/application/model-context/presented-inputs';
import {
  createToolRegistry,
  otherThreadScope,
  toolScope,
} from '../../adapters/inbound/tools/registry-fixture';

const turn: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T04:00:00.000Z',
  freshUntil: '2026-09-10T01:00:00.000Z',
  displayUntil: '2026-09-10T04:00:00.000Z',
  retentionUntil: '2026-09-10T04:00:00.000Z',
  deletionScheduledAt: '2026-09-10T04:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const shortProvider: RetentionMetadata = {
  ...turn,
  freshUntil: '2026-09-10T00:30:00.000Z',
  displayUntil: '2026-09-10T02:00:00.000Z',
  retentionUntil: '2026-09-10T02:00:00.000Z',
  deletionScheduledAt: '2026-09-10T02:00:00.000Z',
  attribution: { label: 'Provider credit', sourceLink: null },
};

const fixture = () => {
  const tools = createToolRegistry();
  const register = (scope = toolScope, candidateId = tools.currentCandidateId) =>
    tools.registry.registerObservation({
      scope,
      candidateId,
      field: 'identity',
      value: { name: '候補' },
      basis: 'provider_reported',
      sourceUpdatedAt: null,
      freshUntil: '2026-09-10T00:30:00.000Z',
      expiresAt: '2026-09-10T02:00:00.000Z',
      context: {
        ...scope,
        capabilityVersion: 'v1',
        locationRevision: 1,
        timeContext: 'fixture',
      },
      sources: [{ provider: 'fixture', recordRef: 'record', attribution: null, publicUrl: null }],
      retention: shortProvider,
    }).observationId;
  const presented = createPresentedInputs({ registry: tools.registry, scope: toolScope });
  return { tools, register, presented };
};

describe('presented model inputs', () => {
  it('leaves the turn policy unchanged when no provider content was shown', () => {
    expect(fixture().presented.textRetention(turn)).toEqual(turn);
  });

  it('bounds the text by the policy of each shown observation', () => {
    const f = fixture();
    f.presented.observation(f.register());
    expect(f.presented.textRetention(turn)).toMatchObject({
      retentionDecision: 'allow',
      freshUntil: shortProvider.freshUntil,
      displayUntil: shortProvider.displayUntil,
      retentionUntil: shortProvider.retentionUntil,
      attribution: shortProvider.attribution,
    });
  });

  it('never stores text that was shown content of unknown origin, but keeps it displayable', () => {
    const f = fixture();
    const foreign = f.register(otherThreadScope, f.tools.otherThreadCandidateId);
    f.presented.observation(foreign);
    f.presented.observation('observation-missing');
    const retention = f.presented.textRetention(turn);
    expect(retention.retentionDecision).not.toBe('allow');
    expect(retention.retentionUntil).toBeNull();
    expect(retention.restoreMode).not.toBe('full');
    expect(retention.displayPolicyStatus).toBe('available');
  });

  it('keeps a stricter earlier input however many inputs follow', () => {
    const f = fixture();
    f.presented.retention({
      ...turn,
      retentionDecision: 'deny',
      retentionMode: 'session_only',
      freshUntil: null,
      displayUntil: null,
      retentionUntil: null,
      deletionScheduledAt: null,
      restoreMode: 'reference_only',
      policyStatus: 'policy_withheld',
      displayPolicyStatus: 'policy_withheld',
    });
    for (let index = 0; index < 200; index += 1) f.presented.retention(turn);
    expect(f.presented.textRetention(turn)).toMatchObject({
      retentionDecision: 'deny',
      displayPolicyStatus: 'policy_withheld',
    });
  });

  it('ends every window by the expiry of quoted content', () => {
    const f = fixture();
    f.presented.deadline('2026-09-10T00:45:00.000Z');
    f.presented.deadline('2026-09-10T03:00:00.000Z');
    expect(f.presented.textRetention(turn)).toMatchObject({
      sessionExpiresAt: '2026-09-10T00:45:00.000Z',
      displayUntil: '2026-09-10T00:45:00.000Z',
      retentionUntil: '2026-09-10T00:45:00.000Z',
    });
  });
});
