import { describe, expect, it, vi } from 'vitest';
import type { OwnerStore } from '@core/ports/owner-store';
import {
  decideOwnerPlace,
  registerOwnerSavedReference,
  type OwnerReferenceFingerprint,
  type OwnerSavedCandidateResolver,
} from '@core/application/saved-references/owner-operations';

const reference = {
  savedPlaceRef: 'saved-1',
  ownerScopeRef: 'owner-1',
  provider: 'hotpepper',
  recordRef: 'shop-1',
};
const input = {
  ownerScopeRef: 'owner-1',
  threadId: 'thread-1',
  candidateId: 'candidate-1',
  revision: 3,
  idempotencyKey: 'key-1',
};

const fixture = () => {
  const store = {
    readPrefs: vi.fn<OwnerStore['readPrefs']>(),
    putPrefs: vi.fn<OwnerStore['putPrefs']>(),
    listSaved: vi.fn<OwnerStore['listSaved']>(),
    remove: vi.fn<OwnerStore['remove']>(),
    read: vi.fn<OwnerStore['read']>(),
    replay: vi.fn<OwnerStore['replay']>().mockResolvedValue({ ok: true, found: false }),
    register: vi.fn<OwnerStore['register']>().mockResolvedValue({
      ok: true,
      created: true,
      reference,
    }),
    decide: vi.fn<OwnerStore['decide']>().mockResolvedValue({
      ok: true,
      created: true,
      replayed: false,
      reference,
      decidedAt: '2026-09-10T12:00:00Z',
    }),
  } satisfies OwnerStore;
  const resolveSavedCandidate = vi.fn<OwnerSavedCandidateResolver>().mockResolvedValue({
    ok: true,
    candidateId: input.candidateId,
    provider: reference.provider,
    recordRef: reference.recordRef,
  });
  const fingerprint = vi.fn<OwnerReferenceFingerprint>().mockResolvedValue('request-digest');
  return { store, resolveSavedCandidate, fingerprint };
};

describe('owner saved-reference operations', () => {
  it('replays a saved reference without resolving or registering the original candidate', async () => {
    const dependencies = fixture();
    dependencies.store.replay.mockResolvedValue({ ok: true, found: true, reference });
    await expect(registerOwnerSavedReference(input, dependencies)).resolves.toEqual({
      ok: true,
      reference,
    });
    expect(dependencies.store.replay).toHaveBeenCalledWith('owner-1', 'key-1', 'request-digest');
    expect(dependencies.resolveSavedCandidate).not.toHaveBeenCalled();
    expect(dependencies.store.register).not.toHaveBeenCalled();
  });

  it('resolves the scoped revision and registers identity with the same request digest', async () => {
    const dependencies = fixture();
    await expect(registerOwnerSavedReference(input, dependencies)).resolves.toMatchObject({
      ok: true,
    });
    expect(dependencies.fingerprint).toHaveBeenCalledWith('save', input);
    expect(dependencies.resolveSavedCandidate).toHaveBeenCalledWith({
      ownerScopeRef: input.ownerScopeRef,
      threadId: input.threadId,
      candidateId: input.candidateId,
      revision: input.revision,
    });
    expect(dependencies.store.register).toHaveBeenCalledWith(
      'owner-1',
      { provider: 'hotpepper', recordRef: 'shop-1' },
      { idempotencyKey: 'key-1', idempotencyFingerprint: 'request-digest' },
    );
  });

  it('stops on a replay conflict before candidate resolution or writes', async () => {
    const dependencies = fixture();
    dependencies.store.replay.mockResolvedValue({ ok: false, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(registerOwnerSavedReference(input, dependencies)).resolves.toEqual({
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
      source: 'store',
    });
    expect(dependencies.resolveSavedCandidate).not.toHaveBeenCalled();
    expect(dependencies.store.register).not.toHaveBeenCalled();
  });

  it('distinguishes candidate failures and does not write an unauthorized reference', async () => {
    const dependencies = fixture();
    dependencies.resolveSavedCandidate.mockResolvedValue({ ok: false, code: 'FORBIDDEN' });
    await expect(registerOwnerSavedReference(input, dependencies)).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
      source: 'candidate',
    });
    expect(dependencies.store.register).not.toHaveBeenCalled();
  });

  it('decides through one atomic store operation using the supplied server time', async () => {
    const dependencies = fixture();
    const decidedAt = '2026-09-10T12:00:00Z';
    const request = { ...input, decidedAt };
    await expect(decideOwnerPlace(request, dependencies)).resolves.toMatchObject({
      ok: true,
      decidedAt,
    });
    expect(dependencies.fingerprint).toHaveBeenCalledWith('decide', request);
    expect(dependencies.store.decide).toHaveBeenCalledWith(
      'owner-1',
      { provider: 'hotpepper', recordRef: 'shop-1', decidedAt },
      { idempotencyKey: 'key-1', idempotencyFingerprint: 'request-digest' },
    );
    expect(dependencies.store.replay).not.toHaveBeenCalled();
    expect(dependencies.store.register).not.toHaveBeenCalled();
  });

  it('preserves storage failures and propagates unexpected failures', async () => {
    const dependencies = fixture();
    dependencies.store.decide.mockResolvedValue({ ok: false, code: 'CORRUPT_ROW' });
    await expect(decideOwnerPlace({ ...input, decidedAt: 'now' }, dependencies)).resolves.toEqual({
      ok: false,
      code: 'CORRUPT_ROW',
      source: 'store',
    });
    dependencies.store.replay.mockRejectedValue(new Error('storage unavailable'));
    await expect(registerOwnerSavedReference(input, dependencies)).rejects.toThrow(
      'storage unavailable',
    );
  });
});
