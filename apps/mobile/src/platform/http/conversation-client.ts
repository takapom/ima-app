import {
  parseConversationId,
  parseCreateConversationRequest,
  parseConversationTurnRequest,
  parseConversationResponse,
  parseConversationListResponse,
  parseConversationMessagesResponse,
  parseConversationRunResponse,
  type CreateConversationRequest,
  type ConversationResponse,
  type ConversationListResponse,
  type ConversationMessagesResponse,
  type ConversationTurnRequest,
  type ConversationRunResponse,
  type ParseResult,
} from '@ima/contracts';
import { createApiRequester } from '@mobile/platform/http/client';
import { compatibleTurnBody } from '@mobile/platform/http/request-compatibility';
import { issueResult } from '@mobile/platform/http/response';
import type { ApiClientOptions, ApiRequestOptions, ApiResult } from '@mobile/platform/http/api';
import { watchConversationRun } from '@mobile/platform/http/conversation-stream';

export type ConversationClient = {
  cancel(
    id: string,
    runId: string,
    options?: ApiRequestOptions,
  ): Promise<ApiResult<ConversationRunResponse>>;
  create(
    input: CreateConversationRequest,
    options?: ApiRequestOptions,
  ): Promise<ApiResult<ConversationResponse>>;
  list(
    cursor?: string | null,
    options?: ApiRequestOptions,
  ): Promise<ApiResult<ConversationListResponse>>;
  get(id: string, options?: ApiRequestOptions): Promise<ApiResult<ConversationResponse>>;
  messages(
    id: string,
    before?: number | null,
    options?: ApiRequestOptions,
  ): Promise<ApiResult<ConversationMessagesResponse>>;
  send(
    id: string,
    input: ConversationTurnRequest,
    options?: ApiRequestOptions,
  ): Promise<ApiResult<ConversationRunResponse>>;
  run(
    id: string,
    runId: string,
    options?: ApiRequestOptions,
  ): Promise<ApiResult<ConversationRunResponse>>;
  remove(id: string, options?: ApiRequestOptions): Promise<ApiResult<null>>;
  watch(
    id: string,
    runId: string,
    receive: (value: ConversationRunResponse) => void,
    signal: AbortSignal,
  ): Promise<void>;
};
export const createConversationClient = (options: ApiClientOptions): ConversationClient => {
  const request = createApiRequester(options);
  const pathId = (id: string) => {
    const parsed = parseConversationId(id);
    if (!parsed.success) throw new Error('CONVERSATION_ID_INVALID');
    return encodeURIComponent(parsed.data);
  };
  const path = (id: string) => `/v1/conversations/${pathId(id)}`;
  const get = <T>(
    routePath: string,
    parseResponse: (value: unknown) => ParseResult<T>,
    requestOptions?: ApiRequestOptions,
  ) =>
    request(
      { route: 'conversation', method: 'GET', path: routePath, expectedStatus: 200, parseResponse },
      requestOptions,
    );
  return {
    cancel: (id, runId, requestOptions) => {
      const requestId = options.requestIdFactory();
      return request(
        {
          route: 'conversationCancel',
          method: 'POST',
          path: `${path(id)}/runs/${pathId(runId)}/cancel`,
          body: { schemaVersion: 'v1', requestId },
          requestId,
          expectedStatus: 200,
          parseResponse: parseConversationRunResponse,
        },
        requestOptions,
      );
    },
    create: (input, requestOptions) => {
      const parsed = parseCreateConversationRequest(input);
      if (!parsed.success)
        return Promise.resolve(
          issueResult('client-invalid', 'conversationCreate', parsed.issues, null),
        );
      return request(
        {
          route: 'conversationCreate',
          method: 'POST',
          path: '/v1/conversations',
          body: parsed.data,
          expectedStatus: 201,
          requestId: parsed.data.requestId,
          parseResponse: parseConversationResponse,
        },
        requestOptions,
      );
    },
    list: (cursor, requestOptions) =>
      get(
        `/v1/conversations${cursor === null || cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
        parseConversationListResponse,
        requestOptions,
      ),
    get: (id, requestOptions) => get(path(id), parseConversationResponse, requestOptions),
    messages: (id, before, requestOptions) =>
      get(
        `${path(id)}/messages${before === null || before === undefined ? '' : `?before=${before}`}`,
        parseConversationMessagesResponse,
        requestOptions,
      ),
    send: (id, input, requestOptions) => {
      const parsed = parseConversationTurnRequest(input);
      if (!parsed.success)
        return Promise.resolve(
          issueResult('client-invalid', 'conversationTurn', parsed.issues, null),
        );
      return request(
        {
          route: 'conversationTurn',
          method: 'POST',
          path: `${path(id)}/turns`,
          body: compatibleTurnBody(parsed.data),
          expectedStatus: 202,
          requestId: parsed.data.requestId,
          parseResponse: parseConversationRunResponse,
        },
        requestOptions,
      );
    },
    run: (id, runId, requestOptions) =>
      get(`${path(id)}/runs/${pathId(runId)}`, parseConversationRunResponse, requestOptions),
    remove: (id, requestOptions) =>
      request(
        {
          route: 'conversationDelete',
          method: 'DELETE',
          path: path(id),
          expectedStatus: 204,
          parseResponse: (value: unknown): ParseResult<null> =>
            value === null
              ? { success: true, data: null }
              : { success: false, issues: ['Expected empty response'] },
        },
        requestOptions,
      ),
    watch: (id, runId, receive, signal) =>
      watchConversationRun(options, id, runId, receive, signal),
  };
};
