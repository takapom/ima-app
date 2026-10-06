import { describe, expect, it } from 'vitest';
import { companionEntrance, companionPose } from '@mobile/journey/state/companion-pose';

describe('chat companion pose', () => {
  it('breathes without a word while waiting for input or with no card in view', () => {
    expect(companionPose({ phase: 'empty', noCandidates: false, speech: null })).toEqual({
      pose: 'idle',
      bubble: null,
    });
    expect(companionPose({ phase: 'results', noCandidates: false, speech: null })).toEqual({
      pose: 'idle',
      bubble: null,
    });
  });

  it('leaves its corner while a search runs, since it is running in the conversation', () => {
    expect(companionPose({ phase: 'working', noCandidates: false, speech: null })).toEqual({
      pose: 'away',
      bubble: null,
    });
    expect(
      companionPose({ phase: 'working', noCandidates: true, speech: '前の候補の理由' }),
    ).toEqual({ pose: 'away', bubble: null });
  });

  it('says it found nothing only when the latest reply searched and found no candidates', () => {
    expect(companionPose({ phase: 'results', noCandidates: true, speech: null })).toEqual({
      pose: 'notFound',
      bubble: '見つからなかったわん',
    });
  });

  it('looks troubled when sending failed or was cancelled, without claiming nothing was found', () => {
    expect(companionPose({ phase: 'error', noCandidates: true, speech: null })).toEqual({
      pose: 'oops',
      bubble: null,
    });
    expect(companionPose({ phase: 'cancelled', noCandidates: false, speech: null }).pose).toBe(
      'oops',
    );
  });

  it('speaks the reason for the card in view, word for word, while answers are on screen', () => {
    const speech = '恵比寿駅から徒歩1分。予算650円の駅近カフェ';
    expect(companionPose({ phase: 'results', noCandidates: false, speech })).toEqual({
      pose: 'idle',
      bubble: speech,
    });
    expect(companionPose({ phase: 'empty', noCandidates: false, speech })).toEqual({
      pose: 'idle',
      bubble: speech,
    });
  });

  it('still says it found nothing when the latest reply found nothing, even with an older card in view', () => {
    expect(
      companionPose({ phase: 'results', noCandidates: true, speech: '前の候補の理由' }),
    ).toEqual({
      pose: 'notFound',
      bubble: '見つからなかったわん',
    });
  });

  it('keeps quiet about cards while searching, after a failure or cancel, and once decided', () => {
    const speech = '前の候補の理由';
    expect(companionPose({ phase: 'working', noCandidates: false, speech }).bubble).toBeNull();
    expect(companionPose({ phase: 'error', noCandidates: false, speech }).bubble).toBeNull();
    expect(companionPose({ phase: 'cancelled', noCandidates: false, speech }).bubble).toBeNull();
    expect(companionPose({ phase: 'decided', noCandidates: false, speech })).toEqual({
      pose: 'happy',
      bubble: null,
    });
  });

  it('is happy once a place is decided', () => {
    expect(companionPose({ phase: 'decided', noCandidates: false, speech: null })).toEqual({
      pose: 'happy',
      bubble: null,
    });
  });
});

describe('chat companion entrance', () => {
  it('jumps back into its corner when a search ends', () => {
    expect(companionEntrance('away', 'idle')).toBe('jumpIn');
    expect(companionEntrance('away', 'notFound')).toBe('jumpIn');
    expect(companionEntrance('away', 'oops')).toBe('jumpIn');
  });

  it('hops in place when it only changes pose', () => {
    expect(companionEntrance('idle', 'happy')).toBe('hop');
    expect(companionEntrance('notFound', 'idle')).toBe('hop');
  });

  it('stays still while the pose is unchanged or while it is away', () => {
    expect(companionEntrance('idle', 'idle')).toBe('none');
    expect(companionEntrance('idle', 'away')).toBe('none');
    expect(companionEntrance('away', 'away')).toBe('none');
  });
});
