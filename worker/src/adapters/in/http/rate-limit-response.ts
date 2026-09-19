import { toPublicError } from '@worker/adapters/in/http/errors';

const retryAfter = (value: number | null): string =>
  value !== null && Number.isSafeInteger(value) && value >= 1 ? String(value) : '60';

export const rateLimitedResponse = (requestId: string, seconds: number | null): Response => {
  const body = toPublicError(requestId, { status: 429, code: 'RATE_LIMITED' });
  return Response.json(body, {
    status: 429,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'retry-after': retryAfter(seconds),
    },
  });
};
