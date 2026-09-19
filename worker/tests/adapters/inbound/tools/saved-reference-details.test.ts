import { describe, expect, it, vi } from 'vitest';
import type { CandidateRegistration } from '@worker/domain/candidates/registry';
import type {
  GetPlaceDetailsInput,
  ModelGetPlaceDetailsInput,
  PlaceDetailsPort,
  PlaceSearchPort,
} from '@worker/application/ports/operations';
import type { HarnessContext, ToolExecutionContext } from '@worker/application/ports/context';
import type { SubmitCardsPort } from '@worker/application/ports/submission';
import {
  invokePublicTool,
  resolveModelDetailsInput,
  type ToolBindingDependencies,
  type ToolRuntime,
} from '@worker/adapters/in/tools';
import { createToolRegistry, toolScope } from './registry-fixture';

const context: HarnessContext = {
  ownerScopeRef: toolScope.ownerScopeRef,
  threadId: toolScope.threadId,
  turnId: 'turn-saved-details',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 2_000,
    finalReserveMs: 250,
    modelCallsRemaining: 1,
    readCallsRemaining: 5,
    providerHttpRequestsRemaining: 5,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'saved-details-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['saved-details-fixture'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-saved-details',
  operation: 'get_place_details',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const input = (requests: ModelGetPlaceDetailsInput['requests']): ModelGetPlaceDetailsInput => ({
  requests,
  freshness: 'refresh',
});

const identityUnknown = { status: 'unknown' as const, reason: 'fixture did not return identity' };

const makeDependencies = (options: {
  readonly registry: ToolBindingDependencies['registry'];
  readonly details: PlaceDetailsPort;
  readonly resolver?: ToolBindingDependencies['savedPlaceReferenceResolver'];
  readonly isCancelled?: () => boolean;
  readonly readAdmission?: ToolBindingDependencies['readAdmission'];
}): ToolBindingDependencies => {
  const search: PlaceSearchPort = {
    search: () => Promise.reject(new Error('search should not be called')),
  };
  const submit: SubmitCardsPort = {
    submit: () => Promise.reject(new Error('submit should not be called')),
  };
  const runtime: ToolRuntime = {
    context,
    execution,
    cancellation: { isCancelled: () => false },
    remainingRepairs: 0,
  };
  return {
    registry: options.registry,
    clock: () => context.serverNow,
    search,
    details: options.details,
    submit,
    ...(options.resolver === undefined ? {} : { savedPlaceReferenceResolver: options.resolver }),
    ...(options.readAdmission === undefined ? {} : { readAdmission: options.readAdmission }),
    runtime: () => ({
      ...runtime,
      cancellation: { isCancelled: options.isCancelled ?? (() => false) },
    }),
  };
};

const detailsPort = (calls: GetPlaceDetailsInput[]): PlaceDetailsPort => ({
  read: (received) => {
    calls.push(received);
    return Promise.resolve({
      status: 'ok',
      data: {
        items: received.requests.map((request) => ({
          candidateId: request.candidateId,
          fields: { identity: identityUnknown },
        })),
      },
      warnings: [],
    });
  },
});

describe('model-selected saved reference details', () => {
  it('keeps a direct candidate usable when the saved resolver is unavailable', async () => {
    const fixture = createToolRegistry();
    const calls: GetPlaceDetailsInput[] = [];
    const result = await invokePublicTool(
      'get_place_details',
      input([
        { candidateId: fixture.currentCandidateId, fields: ['identity'] },
        { savedPlaceRef: 'saved-unconfigured', fields: ['identity'] },
      ]),
      makeDependencies({ registry: fixture.registry, details: detailsPort(calls) }),
      { toolCallId: 'details-mixed' },
    );

    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(calls[0]?.requests).toEqual([
      { candidateId: fixture.currentCandidateId, fields: ['identity'] },
    ]);
    const direct = result.data.items.find((item) => 'candidateId' in item);
    const saved = result.data.items.find((item) => 'savedPlaceRef' in item);
    expect(direct).toMatchObject({ candidateId: fixture.currentCandidateId });
    expect(saved).toMatchObject({ savedPlaceRef: 'saved-unconfigured' });
    if (saved === undefined || !('savedPlaceRef' in saved)) return;
    expect(saved).not.toHaveProperty('candidateId');
    expect(saved.fields.identity).toMatchObject({ status: 'error' });
  });

  it('does not call the Core details Port for saved-only input without the Worker resolver', async () => {
    const fixture = createToolRegistry();
    const calls: GetPlaceDetailsInput[] = [];
    const result = await invokePublicTool(
      'get_place_details',
      input([{ savedPlaceRef: 'saved-only', fields: ['identity'] }]),
      makeDependencies({ registry: fixture.registry, details: detailsPort(calls) }),
      { toolCallId: 'details-saved-only' },
    );

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({ savedPlaceRef: 'saved-only' });
  });

  it('maps each resolved candidate back to its originating opaque reference', async () => {
    const fixture = createToolRegistry();
    const second: CandidateRegistration = {
      ...toolScope,
      provider: 'fixture',
      recordRef: 'second-record',
      displayName: 'second-record',
      status: 'operational',
    };
    const secondCandidate = fixture.registry.registerCandidate(second);
    const calls: GetPlaceDetailsInput[] = [];
    const resolver = ({ savedPlaceRef }: { readonly savedPlaceRef: string }) =>
      Promise.resolve({
        status: 'ok' as const,
        candidateId:
          savedPlaceRef === 'saved-a' ? fixture.currentCandidateId : secondCandidate.candidateId,
      });
    const result = await invokePublicTool(
      'get_place_details',
      input([
        { savedPlaceRef: 'saved-a', fields: ['identity'] },
        { savedPlaceRef: 'saved-b', fields: ['identity'] },
      ]),
      makeDependencies({ registry: fixture.registry, details: detailsPort(calls), resolver }),
      { toolCallId: 'details-resolved' },
    );

    expect(calls[0]?.requests).toEqual([
      { candidateId: fixture.currentCandidateId, fields: ['identity'] },
      { candidateId: secondCandidate.candidateId, fields: ['identity'] },
    ]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.items).toMatchObject([
      { candidateId: fixture.currentCandidateId, savedPlaceRef: 'saved-a' },
      { candidateId: secondCandidate.candidateId, savedPlaceRef: 'saved-b' },
    ]);
    expect(
      result.data.items.map((item) => ('savedPlaceRef' in item ? item.savedPlaceRef : null)),
    ).toEqual(['saved-a', 'saved-b']);
  });

  it('keeps an invalid saved resolution as a reference-specific failure', async () => {
    const fixture = createToolRegistry();
    const calls: GetPlaceDetailsInput[] = [];
    const resolver: ToolBindingDependencies['savedPlaceReferenceResolver'] = () =>
      Promise.resolve({
        status: 'ok' as const,
        candidateId: fixture.otherThreadCandidateId,
      });
    const result = await invokePublicTool(
      'get_place_details',
      input([{ savedPlaceRef: 'saved-foreign', fields: ['identity'] }]),
      makeDependencies({ registry: fixture.registry, details: detailsPort(calls), resolver }),
      { toolCallId: 'details-foreign' },
    );

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    const item = result.data.items[0];
    expect(item).toMatchObject({ savedPlaceRef: 'saved-foreign' });
    if (item === undefined || !('savedPlaceRef' in item)) return;
    expect(item).not.toHaveProperty('candidateId');
    expect(item.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'UNKNOWN_CANDIDATE' },
    });
  });

  it('sanitizes resolver failures and rejects an invalid resolver result shape', async () => {
    const fixture = createToolRegistry();
    const calls: GetPlaceDetailsInput[] = [];
    const resolver: ToolBindingDependencies['savedPlaceReferenceResolver'] = ({ savedPlaceRef }) =>
      Promise.resolve(
        savedPlaceRef === 'saved-error'
          ? {
              status: 'error' as const,
              error: {
                code: 'UPSTREAM_UNAVAILABLE' as const,
                path: 'provider.secret.raw',
                retryable: true,
                retryAfterMs: null,
                message: 'RAW_PROVIDER_SENTINEL',
                missingFields: [],
              },
            }
          : savedPlaceRef === 'saved-warning'
            ? {
                status: 'ok' as const,
                candidateId: fixture.currentCandidateId,
                warnings: { message: 'RAW_WARNING_SENTINEL' },
              }
            : { status: 'unexpected' },
      );
    const result = await invokePublicTool(
      'get_place_details',
      input([
        { savedPlaceRef: 'saved-error', fields: ['identity'] },
        { savedPlaceRef: 'saved-shape', fields: ['identity'] },
        { savedPlaceRef: 'saved-warning', fields: ['identity'] },
      ]),
      makeDependencies({ registry: fixture.registry, details: detailsPort(calls), resolver }),
      { toolCallId: 'details-error' },
    );

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    const errors = result.data.items.map((item) =>
      'savedPlaceRef' in item ? item.fields.identity : undefined,
    );
    expect(errors[0]).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_UNAVAILABLE', path: 'requests.0.savedPlaceRef' },
    });
    expect(JSON.stringify(errors[0])).not.toContain('RAW_PROVIDER_SENTINEL');
    expect(errors[1]).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH', path: 'requests.1.savedPlaceRef' },
    });
    expect(errors[2]).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH', path: 'requests.2.savedPlaceRef.warnings' },
    });
  });

  it('does not make an already cancelled saved resolution look successful', async () => {
    const fixture = createToolRegistry();
    let cancelled = true;
    const resolved = await resolveModelDetailsInput(
      input([{ savedPlaceRef: 'saved-cancelled', fields: ['identity'] }]),
      context,
      execution,
      { isCancelled: () => cancelled },
      {
        registry: fixture.registry,
        resolver: () => {
          cancelled = false;
          return Promise.resolve({ status: 'ok', candidateId: fixture.currentCandidateId });
        },
      },
    );

    expect(resolved.cancelled).toBe(true);
    expect(resolved.input).toBeUndefined();
  });

  it('cancels while a saved resolver is pending before Core details I/O', async () => {
    const fixture = createToolRegistry();
    const calls: GetPlaceDetailsInput[] = [];
    let cancelled = false;
    let release: ((value: unknown) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const resolver: ToolBindingDependencies['savedPlaceReferenceResolver'] = () => {
      startedResolve?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = invokePublicTool(
      'get_place_details',
      input([{ savedPlaceRef: 'saved-pending', fields: ['identity'] }]),
      makeDependencies({
        registry: fixture.registry,
        details: detailsPort(calls),
        resolver,
        isCancelled: () => cancelled,
      }),
      { toolCallId: 'details-cancel-pending' },
    );
    await started;
    cancelled = true;
    release?.({ status: 'ok', candidateId: fixture.currentCandidateId });
    const result = await pending;

    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(calls).toHaveLength(0);
  });

  it('settles the catalog when a resolver ignores abort and suppresses its late result', async () => {
    const fixture = createToolRegistry();
    const candidatesBefore = fixture.registry.listCandidates(toolScope);
    const admissionController = new AbortController();
    const released = vi.fn();
    const readAdmission: ToolBindingDependencies['readAdmission'] = {
      reserve: () => ({ ok: true }),
      signalFor: () => admissionController.signal,
      release: released,
    };
    let release: ((value: unknown) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const resolver: ToolBindingDependencies['savedPlaceReferenceResolver'] = () => {
      startedResolve?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const calls: GetPlaceDetailsInput[] = [];
    const pending = invokePublicTool(
      'get_place_details',
      input([{ savedPlaceRef: 'saved-late', fields: ['identity'] }]),
      makeDependencies({
        registry: fixture.registry,
        details: detailsPort(calls),
        resolver,
        readAdmission,
      }),
      { toolCallId: 'details-admission-cancel' },
    );
    await started;
    admissionController.abort();

    await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(calls).toHaveLength(0);
    expect(released).toHaveBeenCalledWith('call-saved-details');
    release?.({ status: 'ok', candidateId: fixture.currentCandidateId });
    await Promise.resolve();
    expect(fixture.registry.listCandidates(toolScope)).toEqual(candidatesBefore);
  });
});
