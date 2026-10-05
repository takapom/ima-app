import { describe, expect, it } from 'vitest';
import { companionPose } from '@mobile/journey/state/companion-pose';

describe('chat companion pose', () => {
  it('breathes while waiting for input or showing cards', () => {
    expect(companionPose({ phase: 'empty', noCandidates: false })).toEqual({
      pose: 'idle',
      bubble: null,
    });
    expect(companionPose({ phase: 'results', noCandidates: false })).toEqual({
      pose: 'idle',
      bubble: null,
    });
  });

  it('runs while a search is in progress, even after a reply that found nothing', () => {
    expect(companionPose({ phase: 'working', noCandidates: false }).pose).toBe('search');
    expect(companionPose({ phase: 'working', noCandidates: true })).toEqual({
      pose: 'search',
      bubble: null,
    });
  });

  it('says it found nothing only when the latest reply searched and found no candidates', () => {
    expect(companionPose({ phase: 'results', noCandidates: true })).toEqual({
      pose: 'notFound',
      bubble: '見つからなかったわん',
    });
  });

  it('looks troubled when sending failed or was cancelled, without claiming nothing was found', () => {
    expect(companionPose({ phase: 'error', noCandidates: true })).toEqual({
      pose: 'oops',
      bubble: null,
    });
    expect(companionPose({ phase: 'cancelled', noCandidates: false }).pose).toBe('oops');
  });

  it('is happy once a place is decided', () => {
    expect(companionPose({ phase: 'decided', noCandidates: false })).toEqual({
      pose: 'happy',
      bubble: null,
    });
  });
});
