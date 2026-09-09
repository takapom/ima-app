import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { PublicErrorSchema } from './errors';

const base = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  message: '短い公開エラー',
};

describe('public HTTP errors', () => {
  it('keeps status and code distinguishable', () => {
    expect(v.safeParse(PublicErrorSchema, { ...base, status: 410, code: 'EXPIRED' }).success).toBe(
      true,
    );
    expect(
      v.safeParse(PublicErrorSchema, { ...base, status: 409, code: 'STALE_TURN' }).success,
    ).toBe(true);
    expect(v.safeParse(PublicErrorSchema, { ...base, status: 401, code: 'INTERNAL' }).success).toBe(
      false,
    );
  });

  it('rejects unknown versions and additional properties', () => {
    expect(
      v.safeParse(PublicErrorSchema, {
        ...base,
        schemaVersion: 'v2',
        status: 400,
        code: 'INVALID_ARGUMENT',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(PublicErrorSchema, {
        ...base,
        status: 422,
        code: 'INVALID_EVIDENCE',
        internal: 'provider record',
      }).success,
    ).toBe(false);
  });
});
