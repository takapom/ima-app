import {
  parsePrefsReadResponse,
  parsePrefsWriteRequest,
  parsePrefsWriteResponse,
  parseSavedReferenceListResponse,
  type PrefsReadResponse,
  type PrefsWriteResponse,
  type SavedReferenceListResponse,
} from '@ima/contracts';
import { createApiRequester } from '@mobile/platform/http/client';
import { issueResult } from '@mobile/platform/http/response';
import type { ApiClientOptions, ApiRequestOptions, ApiResult } from '@mobile/platform/http/api';

const CLIENT_REQUEST_ID = 'client-invalid';

export type OwnerPrefsClient = {
  readonly getPrefs: (options?: ApiRequestOptions) => Promise<ApiResult<PrefsReadResponse>>;
  readonly putPrefs: (
    input: unknown,
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<PrefsWriteResponse>>;
  readonly listSaved: (
    options?: ApiRequestOptions,
  ) => Promise<ApiResult<SavedReferenceListResponse>>;
};

export const createOwnerPrefsClient = (options: ApiClientOptions): OwnerPrefsClient => {
  const request = createApiRequester(options);

  return {
    getPrefs: (requestOptions) =>
      request(
        {
          route: 'prefsRead',
          method: 'GET',
          path: '/v1/prefs',
          expectedStatus: 200,
          parseResponse: parsePrefsReadResponse,
        },
        requestOptions,
      ),
    putPrefs: (input, requestOptions) => {
      const parsed = parsePrefsWriteRequest(input);
      if (!parsed.success) {
        return Promise.resolve(issueResult(CLIENT_REQUEST_ID, 'prefsWrite', parsed.issues, null));
      }
      return request(
        {
          route: 'prefsWrite',
          method: 'PUT',
          path: '/v1/prefs',
          body: parsed.data,
          expectedStatus: 200,
          parseResponse: parsePrefsWriteResponse,
          requestId: parsed.data.requestId,
        },
        requestOptions,
      );
    },
    listSaved: (requestOptions) =>
      request(
        {
          route: 'savedReferenceList',
          method: 'GET',
          path: '/v1/saved',
          expectedStatus: 200,
          parseResponse: parseSavedReferenceListResponse,
        },
        requestOptions,
      ),
  };
};
