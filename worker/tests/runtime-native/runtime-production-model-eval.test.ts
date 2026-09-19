import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { AssistantResponseSchema, type ThreadTurnRequest } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildEvaluationRunFromResponse,
  type LiveTraceSnapshot,
} from '../../tooling/model-eval/live';
import {
  expandEvaluationDataset,
  MODEL_EVALUATION_SCENARIOS,
} from '../../tooling/model-eval/dataset';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/runtime/threads/admission';
import type {
  ProductionThreadDO,
  RuntimeProductionCandidateIdentity,
  RuntimeProductionReport,
} from './runtime-production-worker';

type ProductionTestEnv = Cloudflare.Env & {
  readonly PRODUCTION_THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

const productionEnv = (): ProductionTestEnv => {
  if (!('PRODUCTION_THREADS' in env)) throw new Error('M25_PRODUCTION_THREAD_BINDING_MISSING');
  return env as ProductionTestEnv;
};

const requestFor = (target: ThreadRuntimeTarget): ThreadRuntimeTurnInput => {
  const idempotencyKey = `m25-model-eval-${target.turnId}`;
  const input = {
    schemaVersion: 'v1',
    requestId: `request-${target.turnId}`,
    turnId: target.turnId,
    revision: target.revision,
    text: '渋谷で静かなカフェを探して',
    clientNow: '2026-09-10T12:00:00.000Z',
    location: {
      status: 'unavailable' as const,
      lat: null,
      lng: null,
      accuracyMeters: null,
      precise: false,
      capturedAt: null,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes: null,
      minimumStayMinutes: null,
      areaText: '渋谷',
      budget: 'normal' as const,
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search' as const,
    idempotencyKey,
  } satisfies ThreadTurnRequest;
  return { ...target, idempotencyKey, input };
};

const evaluationCase = (): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === 'new-search');
  if (scenario === undefined) throw new Error('M25_NEW_SEARCH_FIXTURE_MISSING');
  const expanded = expandEvaluationDataset([scenario]);
  const first = expanded[0];
  if (first === undefined) throw new Error('M25_NEW_SEARCH_CASE_MISSING');
  return first;
};

const traceFrom = (
  report: RuntimeProductionReport,
  identities: readonly RuntimeProductionCandidateIdentity[],
): LiveTraceSnapshot => ({
  complete: true,
  modelCalls: report.calls,
  proposedToolCalls: report.toolNames.length,
  executedToolCalls: report.toolNames.length,
  toolNames: report.toolNames,
  upstreamCalls: report.fetchUrls.length,
  latencyMs: 0,
  inputTokens: null,
  outputTokens: null,
  measuredCostUsd: null,
  modelLocationExposed: false,
  preservedConditionFields: [],
  candidateIdentities: identities,
  candidateIdentityMapAvailable: identities.length > 0,
});

describe('model-eval mapping through the native production DO', () => {
  it('maps an actual public card response from the Core registry identity', async () => {
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m25-model-eval',
      threadId: `m25-model-eval-${crypto.randomUUID()}`,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = productionEnv().PRODUCTION_THREADS.getByName(target.threadId);
    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });

    const result = await stub.runRuntimeTurn(requestFor(target));
    expect(result.status).toBe('completed');
    const parsed = v.safeParse(AssistantResponseSchema, result.response);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.kind).toBe('cards');

    const identities = await stub.getRuntimeProductionCandidateIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      provider: 'hotpepper',
      recordRef: 'm16-production-place',
    });
    const mapping = resolveCandidateIdentityMapping(identities, [
      {
        provider: 'hotpepper',
        recordRef: 'm16-production-place',
        evaluationCandidateId: 'candidate-a',
      },
    ]);
    expect(mapping.ok).toBe(true);
    if (!mapping.ok) return;

    const report = await stub.getRuntimeProductionReport();
    if (report === null) throw new Error('M25_PRODUCTION_REPORT_MISSING');
    const converted = buildEvaluationRunFromResponse(
      evaluationCase(),
      parsed.output,
      traceFrom(report, identities),
      undefined,
      { modelVersion: 'fixture:m16-production-default-plan', promptVersion: 'm25-fixture-v1' },
      mapping,
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.run.response.selections[0]?.candidateId).toBe('candidate-a');
    }
  });
});
