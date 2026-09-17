import * as v from 'valibot';
import { IsoTimestampSchema, type Issue } from '@ima/core';
import {
  JOURNEY_DATASET_DO_NAME,
  JourneyDatasetRpcCommandSchema,
} from '@worker/adapters/outbound/persistence/last-train/dataset-do';
import type { JourneyDatasetDO } from '@worker/adapters/outbound/persistence/last-train/dataset-do';
import { parseJsonBody } from '@worker/adapters/inbound/http/input';

export const JOURNEY_DATASET_MANAGEMENT_PATH = '/internal/m14/last-train' as const;
export const JOURNEY_DATASET_ADMIN_HEADER = 'X-Ima-Journey-Dataset-Admin' as const;
export const JOURNEY_DATASET_ADMIN_MAX_BODY_BYTES = 512 * 1024;

export type JourneyDatasetNamespace = Pick<DurableObjectNamespace<JourneyDatasetDO>, 'getByName'>;

export type JourneyDatasetManagementOptions = {
  readonly namespace?: JourneyDatasetNamespace;
  readonly adminToken?: string;
  readonly clock?: () => string;
  readonly maxBodyBytes?: number;
};

type ManagementErrorCode =
  'UNAUTHORIZED' | 'INVALID_ARGUMENT' | 'UNSUPPORTED_MEDIA_TYPE' | 'PAYLOAD_TOO_LARGE' | 'INTERNAL';

const errorResponse = (status: number, code: ManagementErrorCode): Response =>
  Response.json(
    { schemaVersion: 'v1', status: 'error', code },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    },
  );

type JourneyDatasetRpcResult =
  | { readonly status: 'imported'; readonly revision: number; readonly recordCount: number }
  | { readonly status: 'updated'; readonly revision: number; readonly removed: readonly string[] }
  | {
      readonly status: 'unchanged';
      readonly revision: number | null;
      readonly removed: readonly string[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'invalid' | 'conflict' | 'storage';
      readonly issues: readonly Issue[];
    }
  | {
      readonly status: 'alarm_failed';
      readonly commandStatus: 'imported' | 'updated' | 'unchanged';
      readonly revision: number | null;
      readonly issues: readonly Issue[];
    };

const resultStatus = (result: JourneyDatasetRpcResult): number => {
  if (result.status === 'alarm_failed') return 500;
  if (result.status !== 'rejected') return 200;
  if (result.reason === 'conflict') return 409;
  return result.reason === 'storage' ? 500 : 400;
};

const resultResponse = (result: JourneyDatasetRpcResult): Response =>
  Response.json(
    {
      schemaVersion: 'v1',
      status: result.status === 'rejected' || result.status === 'alarm_failed' ? 'error' : 'ok',
      result,
    },
    {
      status: resultStatus(result),
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    },
  );

const sameSecret = (provided: string, expected: string): boolean => {
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  let difference = providedBytes.byteLength ^ expectedBytes.byteLength;
  const length = Math.max(providedBytes.byteLength, expectedBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
};

const serverClock = (clock: () => string): string | null => {
  try {
    const candidate = clock();
    const parsed = v.safeParse(IsoTimestampSchema, candidate);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

/**
 * Handles only the internal maintenance path. The caller must invoke this before the public
 * `/v1/*` router and return its response when non-null; public authentication is not accepted.
 */
export const handleJourneyDatasetManagement = async (
  request: Request,
  options: JourneyDatasetManagementOptions,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== JOURNEY_DATASET_MANAGEMENT_PATH) return null;
  if (request.method !== 'POST') return errorResponse(400, 'INVALID_ARGUMENT');
  if (
    options.namespace === undefined ||
    options.adminToken === undefined ||
    options.adminToken === ''
  ) {
    return errorResponse(500, 'INTERNAL');
  }
  const provided = request.headers.get(JOURNEY_DATASET_ADMIN_HEADER);
  if (provided === null || !sameSecret(provided, options.adminToken)) {
    return errorResponse(401, 'UNAUTHORIZED');
  }
  const body = await parseJsonBody(
    request,
    JourneyDatasetRpcCommandSchema,
    options.maxBodyBytes ?? JOURNEY_DATASET_ADMIN_MAX_BODY_BYTES,
  );
  if (!body.ok) {
    const code: ManagementErrorCode =
      body.failure.status === 413
        ? 'PAYLOAD_TOO_LARGE'
        : body.failure.status === 415
          ? 'UNSUPPORTED_MEDIA_TYPE'
          : body.failure.status === 500
            ? 'INTERNAL'
            : 'INVALID_ARGUMENT';
    return errorResponse(body.failure.status, code);
  }
  const now = serverClock(options.clock ?? (() => new Date().toISOString()));
  if (now === null) return errorResponse(500, 'INTERNAL');
  try {
    const stub = options.namespace.getByName(JOURNEY_DATASET_DO_NAME);
    const result = await stub.execute(body.value, now);
    return resultResponse(result);
  } catch {
    return errorResponse(500, 'INTERNAL');
  }
};
