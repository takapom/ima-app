import { describe, expect, it } from 'vitest';
import {
  candidateDetailInitial,
  closeCandidateDetail,
  openCandidateDetail,
  reconcileCandidateDetail,
  reconcileCandidateDetailScope,
} from '@mobile/journey/state/candidate-detail';

describe('candidate detail selection', () => {
  it('opens and closes without mutating the previous selection', () => {
    const opened = openCandidateDetail(candidateDetailInitial, 'candidate-1');
    expect(opened.openCandidateId).toBe('candidate-1');
    expect(candidateDetailInitial.openCandidateId).toBeNull();
    expect(closeCandidateDetail(opened)).toEqual(candidateDetailInitial);
    expect(opened.openCandidateId).toBe('candidate-1');
  });

  it('switches to the explicitly selected candidate', () => {
    const first = openCandidateDetail(candidateDetailInitial, 'candidate-1');
    expect(openCandidateDetail(first, 'candidate-2').openCandidateId).toBe('candidate-2');
  });

  it('closes when the selected candidate is removed or no candidates are available', () => {
    const state = openCandidateDetail(candidateDetailInitial, 'candidate-1');
    expect(reconcileCandidateDetail(state, ['candidate-2'])).toEqual(candidateDetailInitial);
    expect(reconcileCandidateDetail(state, [])).toEqual(candidateDetailInitial);
    const closed = reconcileCandidateDetail(state, []);
    expect(reconcileCandidateDetail(closed, ['candidate-1'])).toEqual(candidateDetailInitial);
  });

  it('retains a valid selection when the candidate order changes', () => {
    const state = openCandidateDetail(candidateDetailInitial, 'candidate-1');
    expect(reconcileCandidateDetail(state, ['candidate-2', 'candidate-1'])).toBe(state);
  });

  it('closes on card-set replacement even when the candidate ID is reused', () => {
    const state = openCandidateDetail(candidateDetailInitial, 'candidate-1');
    expect(reconcileCandidateDetailScope(state, 'set-1', 'set-2', ['candidate-1'])).toEqual(
      candidateDetailInitial,
    );
    expect(reconcileCandidateDetailScope(state, 'set-1', 'set-1', ['candidate-1'])).toBe(state);
    expect(reconcileCandidateDetailScope(state, 'set-1', null, ['candidate-1'])).toEqual(
      candidateDetailInitial,
    );
  });
});
