import { describe, expect, it } from 'vitest';
import { validateLiveCardContext } from '../../tooling/model-eval/card-context';
import type { CandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import type { EvaluationCase } from '../../tooling/model-eval/types';

const mapping: CandidateIdentityMapping = {
  ok: true,
  pairs: [
    {
      provider: 'google_places',
      recordRef: 'eval-place-a',
      runtimeCandidateId: 'runtime-a',
      evaluationCandidateId: 'candidate-a',
    },
    {
      provider: 'google_places',
      recordRef: 'eval-place-b',
      runtimeCandidateId: 'runtime-b',
      evaluationCandidateId: 'candidate-b',
    },
  ],
  byRuntimeCandidateId: new Map([
    ['runtime-a', 'candidate-a'],
    ['runtime-b', 'candidate-b'],
  ]),
};

const caseFor = (id: EvaluationCase['id']): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`missing scenario: ${id}`);
  return { ...scenario, caseId: `${id}:card-context`, repeat: 1 };
};

const cards = {
  cardSetId: 'model-eval-card-set',
  candidateOrder: ['runtime-a', 'runtime-b'] as const,
  selectedCandidateId: null,
};

const singleCard = { ...cards, candidateOrder: ['runtime-a'] as const };

describe('model-eval formal card context validation', () => {
  it('requires both mapped candidates for compare and translates decide selection', () => {
    const compared = validateLiveCardContext({
      profile: 'compare',
      evaluationCase: caseFor('compare'),
      cardContext: cards,
      mapping,
    });
    expect(compared).toMatchObject({ ok: true });

    const decided = validateLiveCardContext({
      profile: 'decide-action',
      evaluationCase: caseFor('decide-action'),
      cardContext: cards,
      mapping,
    });
    expect(decided).toMatchObject({ ok: true, context: { selectedCandidateId: 'runtime-a' } });

    const decidedWithOneCard = validateLiveCardContext({
      profile: 'decide-action',
      evaluationCase: caseFor('decide-action'),
      cardContext: singleCard,
      mapping,
    });
    expect(decidedWithOneCard).toMatchObject({
      ok: true,
      context: { selectedCandidateId: 'runtime-a' },
    });
  });

  it('keeps clarify unselected and rejects an identity absent from the captured mapping', () => {
    const clarified = validateLiveCardContext({
      profile: 'clarify-ambiguity',
      evaluationCase: caseFor('clarify-ambiguity'),
      cardContext: cards,
      mapping,
    });
    expect(clarified).toMatchObject({ ok: true, context: { selectedCandidateId: null } });

    expect(
      validateLiveCardContext({
        profile: 'compare',
        evaluationCase: caseFor('compare'),
        cardContext: { ...cards, candidateOrder: ['runtime-a', 'runtime-unknown'] },
        mapping,
      }),
    ).toEqual({ ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' });

    expect(
      validateLiveCardContext({
        profile: 'clarify-ambiguity',
        evaluationCase: {
          ...caseFor('clarify-ambiguity'),
          context: { ...caseFor('clarify-ambiguity').context, selectedCandidateId: 'candidate-a' },
        },
        cardContext: cards,
        mapping,
      }),
    ).toEqual({ ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' });

    expect(
      validateLiveCardContext({
        profile: 'clarify-ambiguity',
        evaluationCase: caseFor('clarify-ambiguity'),
        cardContext: { ...cards, selectedCandidateId: 'runtime-a' },
        mapping,
      }),
    ).toEqual({ ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' });
  });
});
