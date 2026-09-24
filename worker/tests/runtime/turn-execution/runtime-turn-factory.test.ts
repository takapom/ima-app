import type { TurnContext } from '@cloudflare/think';
import type { RespondPort } from '@worker/application/ports/submission';
import { describe, expect, it } from 'vitest';
import { RuntimeTurnFactoryError } from '@worker/runtime/turn-execution/runtime-turn-factory';
import type {
  RuntimeSubmitRejection,
  RuntimeTurnOutcome,
} from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import { invokePublicToolEnvelope } from '@worker/adapters/in/tools';
import { modelFor } from '../../support/runtime-model-fixture';
import {
  committedResult,
  context,
  createFactory,
  detailsInput,
  emptyPortCalls,
  envelope,
  submitInput,
  type PortCalls,
} from '../../support/runtime-turn-factory-fixture';

describe('createRuntimeTurnFactory', () => {
  it('keeps the exact public tool set and requires the injected stop condition', async () => {
    const calls: PortCalls = emptyPortCalls();
    const { factory, stopWhen } = createFactory(calls);
    expect(Object.keys(factory.tools).sort()).toEqual([
      'get_place_details',
      'respond',
      'search_places',
    ]);

    const model = modelFor('message', { calls: 0, requests: [] });
    const turn: TurnContext = {
      system: '',
      messages: [],
      tools: factory.tools,
      model,
      continuation: false,
    };
    const config = await factory.hooks.beforeTurn(turn);
    expect(config).toMatchObject({
      activeTools: ['search_places', 'get_place_details', 'respond'],
      maxSteps: 6,
      maxRetries: 0,
      stopWhen,
    });

    const thinkManagedTurn: TurnContext = {
      ...turn,
      tools: {
        ...factory.tools,
        bash: factory.tools.search_places,
        read: factory.tools.search_places,
        write: factory.tools.search_places,
      },
    };
    await expect(factory.hooks.beforeTurn(thinkManagedTurn)).resolves.toMatchObject({
      activeTools: ['search_places', 'get_place_details', 'respond'],
    });

    const extraToolTurn: TurnContext = {
      ...turn,
      tools: { ...factory.tools, unknown_tool: factory.tools.search_places },
    };
    await expect(factory.hooks.beforeTurn(extraToolTurn)).rejects.toMatchObject({
      code: 'TOOL_SET_MISMATCH',
    });
  });

  it('rejects the removed metadata field before any Port or context change', async () => {
    const calls: PortCalls = emptyPortCalls();
    const { factory } = createFactory(calls);
    const result = await invokePublicToolEnvelope(
      'search_places',
      envelope({ metadata: {} }),
      factory.dependencies,
      { toolCallId: 'sdk-search-legacy-metadata' },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(calls.searches).toHaveLength(0);
    expect(factory.context.preferences).toEqual(context.preferences);
  });

  it('records why a submit was refused instead of leaving it invisible', async () => {
    const calls: PortCalls = emptyPortCalls();
    const rejections: RuntimeSubmitRejection[] = [];
    const refusing: RespondPort = {
      respond: () =>
        Promise.resolve({
          status: 'invalid',
          repairable: true,
          remainingRepairs: 2,
          issues: [
            {
              code: 'MISSING_EVIDENCE',
              path: 'hero.evidenceIds',
              candidateId: 'candidate-1',
              message: 'opening-hours evidence is required',
              missingFields: ['opening_hours'],
            },
          ],
        }),
    };
    const { factory } = createFactory(calls, {
      buildRespondPort: () => refusing,
      onSubmitRejected: (rejection) => rejections.push(rejection),
    });

    await invokePublicToolEnvelope('respond', { input: submitInput }, factory.dependencies, {
      toolCallId: 'sdk-submit-refused',
    });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      repairable: true,
      candidates: 1,
      issues: [{ code: 'MISSING_EVIDENCE', missingFields: ['opening_hours'] }],
    });
  });

  it('records the operation shape of a turn that never reached a commit', async () => {
    const calls: PortCalls = emptyPortCalls();
    const outcomes: RuntimeTurnOutcome[] = [];
    const { factory } = createFactory(calls, {
      onTurnOutcome: (outcome) => outcomes.push(outcome),
    });

    await invokePublicToolEnvelope('search_places', envelope(), factory.dependencies, {
      toolCallId: 'sdk-search-only',
    });
    factory.dispose();

    // The distinction the screen cannot show: the model searched but never submitted.
    expect(outcomes).toEqual([{ committed: false, operations: { search_places: 1 } }]);
  });

  it('uses a stable server call ID and rejects reuse for another operation or metadata', async () => {
    const calls: PortCalls = emptyPortCalls();
    const { factory } = createFactory(calls);
    await invokePublicToolEnvelope('search_places', envelope(), factory.dependencies, {
      toolCallId: 'sdk-call-1',
    });
    await invokePublicToolEnvelope('search_places', envelope(), factory.dependencies, {
      toolCallId: 'sdk-call-1',
    });
    expect(calls.searches).toHaveLength(2);
    expect(calls.searchExecutions).toHaveLength(2);
    expect(calls.searchExecutions.map((execution) => execution.callId)).toEqual([
      'server-call-1',
      'server-call-1',
    ]);

    const conflict = await invokePublicToolEnvelope(
      'get_place_details',
      { input: detailsInput },
      factory.dependencies,
      { toolCallId: 'sdk-call-1' },
    );
    expect(conflict.status).toBe('error');
    if (conflict.status === 'error') expect(conflict.error.code).toBe('MISSING_CONTEXT');
    expect(calls.details).toHaveLength(0);

    expect(calls.searches).toHaveLength(2);
  });

  it('reserves and commits submit through the shared RuntimeBudget', async () => {
    const calls: PortCalls = emptyPortCalls();
    const { factory } = createFactory(calls);
    const first = await invokePublicToolEnvelope(
      'respond',
      { input: submitInput },
      factory.dependencies,
      { toolCallId: 'sdk-submit-1' },
    );
    expect(first).toEqual(committedResult);
    expect(factory.budget.snapshot()).toMatchObject({ submitAttempts: 1, completed: true });

    const second = await invokePublicToolEnvelope(
      'respond',
      { input: submitInput },
      factory.dependencies,
      { toolCallId: 'sdk-submit-2' },
    );
    expect(second).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'BUDGET_EXCEEDED' }],
    });
    expect(calls.submits).toHaveLength(1);
  });

  it('builds the submit adapter with the latest clock', async () => {
    const calls: PortCalls = emptyPortCalls();
    let now = context.serverNow;
    const built: Array<{ now: string }> = [];
    const dynamicSubmit: RespondPort = {
      respond: () => Promise.resolve(committedResult),
    };
    const { factory } = createFactory(
      calls,
      {
        buildRespondPort: ({ now: sampledNow }) => {
          built.push({ now: sampledNow });
          return dynamicSubmit;
        },
      },
      () => now,
    );
    now = '2026-09-10T00:01:00Z';
    const result = await invokePublicToolEnvelope(
      'respond',
      { input: submitInput },
      factory.dependencies,
      { toolCallId: 'sdk-submit-fresh-context' },
    );
    expect(result).toEqual(committedResult);
    expect(built).toEqual([{ now }]);
  });

  it('propagates caller abort and dispose to the factory signal before a Port call', async () => {
    const calls: PortCalls = emptyPortCalls();
    const controller = new AbortController();
    const { factory } = createFactory(calls, { signal: controller.signal });
    controller.abort();
    expect(factory.signal.aborted).toBe(true);
    const aborted = await invokePublicToolEnvelope(
      'search_places',
      envelope(),
      factory.dependencies,
      { toolCallId: 'sdk-aborted' },
    );
    expect(aborted.status).toBe('error');
    expect(calls.searches).toHaveLength(0);

    factory.dispose();
    expect(factory.isDisposed()).toBe(true);
    expect(() =>
      factory.dependencies.runtime('search_places', { toolCallId: 'sdk-after-dispose' }),
    ).toThrow(RuntimeTurnFactoryError);
  });
});
