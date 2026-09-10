import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  REQUEST_ID_HEADER,
  parseCreateThreadResponse,
  parseCreateThreadRequest,
  parseLifecycleCommand,
  parseLifecycleResponse,
  parsePublicError,
  parseRequestHeaders,
  parseSearchResponse,
  parseSearchRequest,
  parseThreadTurnRequest,
  parseThreadPath,
  parseThreadSnapshot,
  type ParseResult,
} from '@ima/contracts';
import type {
  ApiClientOptions,
  ApiCredentials,
  ApiError,
  ApiFetch,
  ApiRequestOptions,
  ApiResult,
  JourneyApiClient,
} from './types';
import { runWithinDeadline } from './deadline';
import { issueResult, parserFor, readJson, type ResponseSpec } from './response';

type ResponseParser<T> = (input: unknown) => ParseResult<T>;
type RequestSpec<T> = ResponseSpec<T> & {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly expectedStatus: number;
  readonly requestId?: string;
};

const CLIENT_REQUEST_ID = 'client-invalid';
const DEFAULT_TIMEOUT_MS = 15_000;

const invalidResult = <T>(error: ApiError): ApiResult<T> => ({
  ok: false,
  error,
  requestId: CLIENT_REQUEST_ID,
});

const isCredentials = (value: unknown): value is ApiCredentials =>
  typeof value === 'object' &&
  value !== null &&
  'appToken' in value &&
  typeof value.appToken === 'string' &&
  'deviceId' in value &&
  typeof value.deviceId === 'string' &&
  'ownerCredential' in value &&
  typeof value.ownerCredential === 'string';

const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 ? seconds : null;
};

const routePath = (path: string): string => (path.startsWith('/') ? path : `/${path}`);

const buildUrl = (baseUrl: string, path: string, mode: ApiClientOptions['mode']): URL | null => {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    if (mode === 'live' && base.protocol !== 'https:') return null;
    if (
      mode === 'fixture' &&
      base.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    ) {
      return null;
    }
    return new URL(routePath(path), base);
  } catch {
    return null;
  }
};

const timeoutFor = (candidate: number | undefined, fallback: number): number | null => {
  const value = candidate ?? fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const nextRevision = (revision: number): number =>
  revision >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : revision + 1;

const credentialHeaders = async (
  options: ApiClientOptions,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly error: ApiError }
> => {
  let raw: unknown;
  try {
    raw =
      typeof options.credentials === 'function' ? await options.credentials() : options.credentials;
  } catch {
    return { ok: false, error: { kind: 'credentials', reason: 'unavailable' } };
  }
  if (!isCredentials(raw)) {
    return { ok: false, error: { kind: 'credentials', reason: 'missing' } };
  }
  const parsed = parseRequestHeaders({
    ...raw,
    requestId,
    appVersion: options.appVersion,
  });
  if (!parsed.success) return { ok: false, error: { kind: 'credentials', reason: 'invalid' } };
  return {
    ok: true,
    headers: {
      [APP_TOKEN_HEADER]: parsed.data.appToken,
      [DEVICE_ID_HEADER]: parsed.data.deviceId,
      [OWNER_CREDENTIAL_HEADER]: parsed.data.ownerCredential,
      [REQUEST_ID_HEADER]: parsed.data.requestId,
      [APP_VERSION_HEADER]: parsed.data.appVersion,
    },
  };
};

export const createJourneyApiClient = (options: ApiClientOptions): JourneyApiClient => {
  const fetchImpl: ApiFetch = options.fetchImpl ?? fetch;

  const request = async <T>(
    spec: RequestSpec<T>,
    requestOptions: ApiRequestOptions = {},
  ): Promise<ApiResult<T>> => {
    const timeoutMs = timeoutFor(requestOptions.timeoutMs, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (timeoutMs === null)
      return invalidResult({ kind: 'configuration', reason: 'invalid_timeout' });
    const url = buildUrl(options.baseUrl, spec.path, options.mode);
    if (url === null) return invalidResult({ kind: 'configuration', reason: 'invalid_base_url' });

    let requestId: string;
    try {
      requestId = spec.requestId ?? options.requestIdFactory();
    } catch {
      return invalidResult({ kind: 'configuration', reason: 'invalid_request_id' });
    }
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return invalidResult({ kind: 'configuration', reason: 'invalid_request_id' });
    }
    if (requestOptions.signal?.aborted) return { ok: false, error: { kind: 'aborted' }, requestId };
    const deadlineAt = Date.now() + timeoutMs;
    const credentialOutcome = await runWithinDeadline(
      credentialHeaders(options, requestId),
      deadlineAt,
      requestOptions.signal,
    );
    if (credentialOutcome.kind === 'rejected') {
      return { ok: false, error: { kind: 'credentials', reason: 'unavailable' }, requestId };
    }
    if (credentialOutcome.kind !== 'done') {
      return { ok: false, error: { kind: credentialOutcome.kind }, requestId };
    }
    const auth = credentialOutcome.value;
    if (!auth.ok) return { ok: false, error: auth.error, requestId };
    if (requestOptions.signal?.aborted) return { ok: false, error: { kind: 'aborted' }, requestId };

    let encodedBody: string | undefined;
    if (spec.body !== undefined) {
      try {
        encodedBody = JSON.stringify(spec.body);
      } catch {
        return issueResult(requestId, spec.route, ['request body is not JSON serializable'], null);
      }
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const fetchWork = (async (): Promise<ApiResult<T>> => {
      const response = await fetchImpl(url, {
        method: spec.method,
        redirect: 'error',
        headers: {
          ...auth.headers,
          ...(encodedBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        signal: controller.signal,
      });
      if (requestOptions.signal?.aborted) {
        return { ok: false, error: { kind: 'aborted' }, requestId };
      }
      const raw = response.status === 204 ? null : await readJson(response);
      if (requestOptions.signal?.aborted) {
        return { ok: false, error: { kind: 'aborted' }, requestId };
      }
      if (!response.ok) {
        const parsedError = parsePublicError(raw);
        if (!parsedError.success) {
          return issueResult(requestId, spec.route, parsedError.issues, response.status);
        }
        if (
          parsedError.data.requestId !== requestId ||
          parsedError.data.status !== response.status
        ) {
          return issueResult(
            requestId,
            spec.route,
            ['error response identity does not match the request'],
            response.status,
          );
        }
        return {
          ok: false,
          requestId,
          error: {
            kind: 'http',
            status: response.status,
            publicError: parsedError.data,
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
          },
        };
      }
      if (response.status !== spec.expectedStatus) {
        return issueResult(requestId, spec.route, ['unexpected success status'], response.status);
      }
      return parserFor(spec, requestId)(raw, response.status);
    })();
    const fetchOutcome = await runWithinDeadline(
      fetchWork,
      deadlineAt,
      requestOptions.signal,
      onAbort,
    );
    requestOptions.signal?.removeEventListener('abort', onAbort);
    if (fetchOutcome.kind === 'rejected') {
      return { ok: false, error: { kind: 'offline' }, requestId };
    }
    if (fetchOutcome.kind !== 'done') {
      return { ok: false, error: { kind: fetchOutcome.kind }, requestId };
    }
    return fetchOutcome.value;
  };

  const checkedThreadPath = (threadId: string): ApiResult<{ readonly threadId: string }> => {
    const parsed = parseThreadPath({ threadId });
    return parsed.success
      ? { ok: true, data: parsed.data, requestId: CLIENT_REQUEST_ID }
      : invalidResult({ kind: 'contract', route: 'thread', issues: parsed.issues, status: null });
  };

  const threadRequest = async <T>(
    route: string,
    method: 'GET' | 'POST' | 'DELETE',
    threadId: string,
    suffix: string,
    body: unknown,
    expectedStatus: number,
    parseResponse: ResponseParser<T>,
    requestOptions?: ApiRequestOptions,
  ): Promise<ApiResult<T>> => {
    const path = checkedThreadPath(threadId);
    if (!path.ok) return path;
    return request(
      {
        route,
        method,
        path: `/v1/threads/${encodeURIComponent(path.data.threadId)}${suffix}`,
        ...(body === undefined ? {} : { body }),
        expectedStatus,
        parseResponse,
        ...(typeof body === 'object' &&
        body !== null &&
        'requestId' in body &&
        typeof body.requestId === 'string'
          ? { requestId: body.requestId }
          : {}),
        expectedThreadId: path.data.threadId,
        ...(typeof body === 'object' &&
        body !== null &&
        'turnId' in body &&
        typeof body.turnId === 'string'
          ? { expectedTurnId: body.turnId }
          : {}),
        ...(typeof body === 'object' &&
        body !== null &&
        'revision' in body &&
        typeof body.revision === 'number'
          ? { minimumRevision: nextRevision(body.revision) }
          : {}),
      },
      requestOptions,
    );
  };

  return {
    mode: options.mode,
    search: (input, requestOptions) => {
      const parsed = parseSearchRequest(input);
      if (!parsed.success)
        return Promise.resolve(issueResult(CLIENT_REQUEST_ID, 'search', parsed.issues, null));
      return request(
        {
          route: 'search',
          method: 'POST',
          path: '/v1/search',
          body: parsed.data,
          expectedStatus: 200,
          parseResponse: parseSearchResponse,
          requestId: parsed.data.requestId,
          expectedThreadId: parsed.data.threadId,
          ...(parsed.data.turnId === null ? {} : { expectedTurnId: parsed.data.turnId }),
          minimumRevision: nextRevision(parsed.data.revision),
        },
        requestOptions,
      );
    },
    createThread: (input, requestOptions) => {
      const parsed = parseCreateThreadRequest(input);
      if (!parsed.success) {
        return Promise.resolve(issueResult(CLIENT_REQUEST_ID, 'createThread', parsed.issues, null));
      }
      return request(
        {
          route: 'createThread',
          method: 'POST',
          path: '/v1/threads',
          body: parsed.data,
          expectedStatus: 201,
          parseResponse: parseCreateThreadResponse,
          requestId: parsed.data.requestId,
        },
        requestOptions,
      );
    },
    turn: (threadId, input, requestOptions) => {
      const parsed = parseThreadTurnRequest(input);
      if (!parsed.success) {
        return Promise.resolve(issueResult(CLIENT_REQUEST_ID, 'turn', parsed.issues, null));
      }
      return threadRequest(
        'turn',
        'POST',
        threadId,
        '/turns',
        parsed.data,
        200,
        parseSearchResponse,
        requestOptions,
      );
    },
    readThread: (threadId: string, requestOptions) =>
      threadRequest(
        'readThread',
        'GET',
        threadId,
        '',
        undefined,
        200,
        parseThreadSnapshot,
        requestOptions,
      ),
    replayThread: (threadId: string, requestOptions) =>
      threadRequest(
        'replayThread',
        'GET',
        threadId,
        '/replay',
        undefined,
        200,
        parseThreadSnapshot,
        requestOptions,
      ),
    lifecycle: (action, threadId, input, requestOptions) => {
      const command = parseLifecycleCommand(input);
      if (!command.success) {
        return Promise.resolve(
          invalidResult({ kind: 'contract', route: action, issues: command.issues, status: null }),
        );
      }
      return threadRequest(
        action,
        'POST',
        threadId,
        `/${action}`,
        command.data,
        200,
        parseLifecycleResponse,
        requestOptions,
      );
    },
    deleteThread: (threadId, input, requestOptions) => {
      const command = parseLifecycleCommand(input);
      if (!command.success) {
        return Promise.resolve(
          invalidResult({
            kind: 'contract',
            route: 'deleteThread',
            issues: command.issues,
            status: null,
          }),
        );
      }
      return threadRequest(
        'deleteThread',
        'DELETE',
        threadId,
        '',
        command.data,
        204,
        (value) =>
          value === null
            ? { success: true, data: null }
            : { success: false, issues: ['expected empty response'] },
        requestOptions,
      );
    },
  };
};
