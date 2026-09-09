import { expect, it } from 'vitest';
import { normalizeRuntimeGateReport, normalizeThinkRuntimeReport } from './runtime-gate-http';
import {
  validSubmitInput,
  validSubmitInputThree,
  validSubmitInputTwo,
} from '../runtime-gate-provider';
import type { SubmitCardsInput } from '@ima/core';

const context = { threadId: 'thread-http-mobile', turnId: 'turn-http-mobile', revision: 1 };

type ThinkHttpFixtureReport = {
  result: { requestId: string; status: string; error: string | null };
  replay: {
    outcome: string;
    commit: {
      responseId: string;
      revision: number;
      candidateIds: string[];
      evidenceIds: string[];
    };
  };
  core: { commits: Array<{ candidateIds: string[]; evidenceIds: string[] }> };
  toolExecutions: Array<{ name: 'submit_cards'; input: SubmitCardsInput }>;
  step: { acceptedSteps: unknown[] };
};

function thinkCardReport(input: SubmitCardsInput): ThinkHttpFixtureReport {
  const selections = [input.hero, ...input.alts];
  const commit = {
    responseId: 'response-think-runtime-1',
    revision: 1,
    candidateIds: selections.map((selection) => selection.candidateId),
    evidenceIds: selections.flatMap((selection) => selection.evidenceIds),
  };
  return {
    result: { requestId: 'request-think-runtime-1', status: 'completed', error: null },
    replay: { outcome: 'stored', commit },
    core: { commits: [{ candidateIds: commit.candidateIds, evidenceIds: commit.evidenceIds }] },
    toolExecutions: [{ name: 'submit_cards', input }],
    step: { acceptedSteps: [] },
  };
}

it('does not promote an error report that also contains a commit', () => {
  expect(() =>
    normalizeRuntimeGateReport(
      {
        result: { requestId: 'request-error', status: 'error', error: 'fixture failure' },
        replay: {
          outcome: 'stored',
          commit: {
            responseId: 'response-runtime-gate-1',
            revision: 1,
            candidateIds: ['candidate-1'],
            evidenceIds: ['obs-identity-1'],
          },
        },
        core: { commits: [{ candidateIds: ['candidate-1'], evidenceIds: ['obs-identity-1'] }] },
        toolExecutions: [],
        step: { acceptedSteps: [] },
      },
      { threadId: 'thread-http-mobile', turnId: 'turn-http-mobile', revision: 1 },
    ),
  ).toThrow('FIXTURE_POLICY_FAILED');
});

it('does not promote a completed report that still carries an error', () => {
  expect(() =>
    normalizeRuntimeGateReport(
      {
        result: {
          requestId: 'request-completed-error',
          status: 'completed',
          error: 'late failure',
        },
        replay: { outcome: 'none', commit: null },
        core: { commits: [] },
        toolExecutions: [],
        step: { acceptedSteps: [] },
      },
      { threadId: 'thread-http-mobile', turnId: 'turn-http-mobile', revision: 1 },
    ),
  ).toThrow('FIXTURE_POLICY_FAILED');
});

it('converts Think registry evidence into one, two, and three public cards', () => {
  for (const input of [validSubmitInput, validSubmitInputTwo, validSubmitInputThree]) {
    const response = normalizeThinkRuntimeReport(thinkCardReport(input), context);
    expect(response.response.kind).toBe('cards');
    if (response.response.kind !== 'cards') throw new Error('expected cards response');
    const cards = [response.response.cards.hero, ...response.response.cards.alts];
    expect(cards).toHaveLength(1 + input.alts.length);
    const evidenceIds = cards.map((card) => {
      if (card.facts.identity.status !== 'known') throw new Error('expected identity evidence');
      return card.facts.identity.evidence.map((entry) => entry.evidenceId);
    });
    expect(evidenceIds).toEqual(
      cards.map((card) => [`obs-identity-${card.candidateId.slice(-1)}`]),
    );
  }
});

it('keeps a committed card response when the following final step is empty', () => {
  const report = thinkCardReport(validSubmitInput);
  report.step.acceptedSteps = [{ emptyFinal: true }];
  const response = normalizeThinkRuntimeReport(report, context);
  expect(response.response.kind).toBe('cards');
});

it('rejects opening-hours evidence used as identity evidence', () => {
  const wrongIdentity: SubmitCardsInput = {
    ...validSubmitInput,
    hero: {
      ...validSubmitInput.hero,
      evidenceIds: ['obs-opening-hours-1'],
      why: { ...validSubmitInput.hero.why, evidenceIds: ['obs-opening-hours-1'] },
    },
  };
  expect(() => normalizeThinkRuntimeReport(thinkCardReport(wrongIdentity), context)).toThrow(
    'FIXTURE_IDENTITY_EVIDENCE_MISMATCH:candidate-1',
  );
});

it('rejects a selected card when the Core commit is missing', () => {
  const report = thinkCardReport(validSubmitInput);
  report.core.commits = [];
  expect(() => normalizeThinkRuntimeReport(report, context)).toThrow('FIXTURE_NO_PUBLIC_RESULT');
});

it('fails Think conversion when a failed SDK result carries a commit', () => {
  const report = thinkCardReport(validSubmitInput);
  report.result = {
    requestId: 'request-think-runtime-error',
    status: 'error',
    error: 'provider failed',
  };
  expect(() => normalizeThinkRuntimeReport(report, context)).toThrow('FIXTURE_POLICY_FAILED');
});
