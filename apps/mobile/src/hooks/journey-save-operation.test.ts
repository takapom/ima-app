import { describe, expect, it } from 'vitest';
import { createJourneySaveOperationRegistry } from './journey-save-operation';

describe('journey save operation keys', () => {
  it('reuses one opaque key for a retry and separates response contexts', () => {
    const operations = createJourneySaveOperationRegistry();
    const first = operations.keyFor('save:thread:1:candidate');
    const retry = operations.keyFor('save:thread:1:candidate');
    const nextContext = operations.keyFor('save:thread:2:candidate');

    expect(first).toBe(retry);
    expect(nextContext).not.toBe(first);
    expect(first).toMatch(/^save-[A-Za-z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it('does not reuse a key after the host clears the context registry', () => {
    const operations = createJourneySaveOperationRegistry();
    const first = operations.keyFor('save:thread:1:candidate');
    operations.clearKeys();

    const next = operations.keyFor('save:thread:1:candidate');
    expect(next).not.toBe(first);
  });

  it('does not let an old completion release a newer retry', () => {
    const operations = createJourneySaveOperationRegistry();
    const first = operations.begin('save:thread:1:candidate');
    if (first === null) throw new Error('first save should start');
    operations.abortAll();
    const retry = operations.begin('save:thread:1:candidate');
    if (retry === null) throw new Error('retry should start');

    expect(first.signal.aborted).toBe(true);
    operations.finish('save:thread:1:candidate', first);
    expect(operations.begin('save:thread:1:candidate')).toBeNull();
    operations.finish('save:thread:1:candidate', retry);
    expect(operations.begin('save:thread:1:candidate')).not.toBeNull();
  });

  it('aborts every pending save when the active UI scope is cancelled', () => {
    const operations = createJourneySaveOperationRegistry();
    const first = operations.begin('save:thread:1:hero');
    const second = operations.begin('save:thread:1:alt');
    if (first === null || second === null) throw new Error('saves should start');

    operations.abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(operations.begin('save:thread:1:hero')).not.toBeNull();
  });
});
