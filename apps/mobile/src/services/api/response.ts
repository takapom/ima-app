import type { ParseResult } from '@ima/contracts';
import type { ApiResult } from './types';

export type ResponseSpec<T> = {
  readonly route: string;
  readonly parseResponse: (input: unknown) => ParseResult<T>;
  readonly expectedThreadId?: string;
  readonly expectedTurnId?: string;
  readonly minimumRevision?: number;
};

export const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

export const issueResult = <T>(
  requestId: string,
  route: string,
  issues: readonly string[],
  status: number | null,
): ApiResult<T> => ({
  ok: false,
  requestId,
  error: { kind: 'contract', route, issues, status },
});

const responseRequestId = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return null;
  return typeof value.requestId === 'string' ? value.requestId : null;
};

const responseThreadId = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('threadId' in value)) return null;
  return typeof value.threadId === 'string' ? value.threadId : null;
};

const responseTurnId = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('turnId' in value)) return null;
  return typeof value.turnId === 'string' ? value.turnId : null;
};

const responseRevision = (value: unknown): number | null => {
  if (typeof value !== 'object' || value === null || !('revision' in value)) return null;
  return typeof value.revision === 'number' ? value.revision : null;
};

const responseCorrelation = (
  route: string,
  value: unknown,
): {
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly revision: number | null;
} => {
  if (route === 'search' || route === 'turn') {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('response' in value) ||
      typeof value.response !== 'object' ||
      value.response === null
    ) {
      return { threadId: null, turnId: null, revision: null };
    }
    return {
      threadId: responseThreadId(value.response),
      revision: responseRevision(value.response),
      turnId: responseTurnId(value.response),
    };
  }
  return {
    threadId: responseThreadId(value),
    revision: responseRevision(value),
    turnId: responseTurnId(value),
  };
};

export const parserFor =
  <T>(spec: ResponseSpec<T>, requestId: string) =>
  (value: unknown, status: number): ApiResult<T> => {
    const parsed = spec.parseResponse(value);
    if (!parsed.success) return issueResult(requestId, spec.route, parsed.issues, status);
    const bodyRequestId = responseRequestId(parsed.data);
    if (bodyRequestId !== null && bodyRequestId !== requestId) {
      return issueResult(
        requestId,
        spec.route,
        ['response requestId does not match the request'],
        status,
      );
    }
    const correlation = responseCorrelation(spec.route, parsed.data);
    if (
      spec.expectedThreadId !== undefined &&
      status !== 204 &&
      correlation.threadId !== spec.expectedThreadId
    ) {
      return issueResult(
        requestId,
        spec.route,
        ['response threadId does not match the request'],
        status,
      );
    }
    if (
      spec.expectedTurnId !== undefined &&
      status !== 204 &&
      correlation.turnId !== spec.expectedTurnId
    ) {
      return issueResult(
        requestId,
        spec.route,
        ['response turnId does not match the request'],
        status,
      );
    }
    if (
      spec.minimumRevision !== undefined &&
      status !== 204 &&
      (correlation.revision === null || correlation.revision < spec.minimumRevision)
    ) {
      return issueResult(
        requestId,
        spec.route,
        ['response revision is older than the request'],
        status,
      );
    }
    return { ok: true, data: parsed.data, requestId };
  };
