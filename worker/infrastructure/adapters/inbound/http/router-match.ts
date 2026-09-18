import * as v from 'valibot';
import { PhotoPathSchema, SavedReferencePathSchema, ThreadPathSchema } from '@ima/contracts';
import type { BoundaryFailure } from '@worker/infrastructure/adapters/inbound/http/errors';
import type {
  PhotoPath,
  SavedReferencePath,
  ThreadPath,
} from '@worker/infrastructure/adapters/inbound/http/handler';

export type LifecycleAction = 'cancel' | 'resume' | 'restart' | 'end';

export type MatchedRoute =
  | { readonly kind: 'attest_nonce' }
  | { readonly kind: 'attest_enroll' }
  | { readonly kind: 'attest_revoke' }
  | { readonly kind: 'create_thread' }
  | { readonly kind: 'search' }
  | { readonly kind: 'photos'; readonly path: PhotoPath }
  | { readonly kind: 'prefs_read' }
  | { readonly kind: 'prefs_write' }
  | { readonly kind: 'saved_reference_list' }
  | { readonly kind: 'saved_reference_refresh'; readonly path: SavedReferencePath }
  | { readonly kind: 'saved_reference_create'; readonly path: ThreadPath }
  | { readonly kind: 'saved_reference_delete'; readonly path: SavedReferencePath }
  | { readonly kind: 'place_decide'; readonly path: ThreadPath }
  | { readonly kind: 'events' }
  | { readonly kind: 'turn'; readonly path: ThreadPath }
  | { readonly kind: 'read_thread'; readonly path: ThreadPath }
  | { readonly kind: 'replay_thread'; readonly path: ThreadPath }
  | {
      readonly kind: 'lifecycle';
      readonly action: LifecycleAction;
      readonly path: ThreadPath;
    }
  | { readonly kind: 'delete_thread'; readonly path: ThreadPath };

export type MatchResult =
  | { readonly ok: true; readonly route: MatchedRoute }
  | { readonly ok: false; readonly failure: BoundaryFailure };

const notFound = (): BoundaryFailure => ({ status: 404, code: 'NOT_FOUND' });
const invalidArgument = (): BoundaryFailure => ({ status: 400, code: 'INVALID_ARGUMENT' });

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const parseThread = (threadId: string): ThreadPath | null => {
  const decoded = decodeSegment(threadId);
  if (decoded === null) return null;
  const parsed = v.safeParse(ThreadPathSchema, { threadId: decoded });
  return parsed.success ? parsed.output : null;
};

const parsePhoto = (token: string): PhotoPath | null => {
  const decoded = decodeSegment(token);
  if (decoded === null) return null;
  const parsed = v.safeParse(PhotoPathSchema, { token: decoded });
  return parsed.success ? parsed.output : null;
};

const parseSaved = (savedPlaceRef: string): SavedReferencePath | null => {
  const decoded = decodeSegment(savedPlaceRef);
  if (decoded === null) return null;
  const parsed = v.safeParse(SavedReferencePathSchema, { savedPlaceRef: decoded });
  return parsed.success ? parsed.output : null;
};

const isLifecycleAction = (value: string | undefined): value is LifecycleAction =>
  value === 'cancel' || value === 'resume' || value === 'restart' || value === 'end';

/** Match the exact public RouteContracts entries; trailing or extra segments are rejected. */
export const matchRoute = (request: Request): MatchResult => {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').slice(1);
  const [version, first, second, third] = segments;
  if (version !== 'v1') return { ok: false, failure: notFound() };

  if (first === 'attest' && second === 'nonce' && segments.length === 3) {
    return request.method === 'GET' && url.search.length === 0
      ? { ok: true, route: { kind: 'attest_nonce' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (first === 'attest' && second === 'enroll' && segments.length === 3) {
    return request.method === 'POST' && url.search.length === 0
      ? { ok: true, route: { kind: 'attest_enroll' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (first === 'attest' && second === 'revoke' && segments.length === 3) {
    return request.method === 'POST' && url.search.length === 0
      ? { ok: true, route: { kind: 'attest_revoke' } }
      : { ok: false, failure: invalidArgument() };
  }

  if (request.method === 'POST' && first === 'search' && segments.length === 2) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'search' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'POST' && first === 'threads' && segments.length === 2) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'create_thread' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'POST' && first === 'events' && segments.length === 2) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'events' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'GET' && first === 'photos' && segments.length === 3) {
    const path = parsePhoto(second ?? '');
    return path === null
      ? { ok: false, failure: invalidArgument() }
      : url.search.length === 0
        ? { ok: true, route: { kind: 'photos', path } }
        : { ok: false, failure: invalidArgument() };
  }
  if (
    (request.method === 'GET' || request.method === 'PUT') &&
    first === 'prefs' &&
    segments.length === 2
  ) {
    return url.search.length === 0
      ? { ok: true, route: { kind: request.method === 'GET' ? 'prefs_read' : 'prefs_write' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'GET' && first === 'saved' && segments.length === 2) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'saved_reference_list' } }
      : { ok: false, failure: invalidArgument() };
  }
  if (
    request.method === 'GET' &&
    first === 'saved' &&
    third === 'refresh' &&
    segments.length === 4
  ) {
    const path = parseSaved(second ?? '');
    return path === null
      ? { ok: false, failure: invalidArgument() }
      : url.search.length === 0
        ? { ok: true, route: { kind: 'saved_reference_refresh', path } }
        : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'DELETE' && first === 'saved' && segments.length === 3) {
    const path = parseSaved(second ?? '');
    return path === null
      ? { ok: false, failure: invalidArgument() }
      : url.search.length === 0
        ? { ok: true, route: { kind: 'saved_reference_delete', path } }
        : { ok: false, failure: invalidArgument() };
  }
  if (first !== 'threads' || segments.length < 3) return { ok: false, failure: notFound() };

  const path = parseThread(second ?? '');
  if (path === null) return { ok: false, failure: invalidArgument() };
  if (request.method === 'POST' && third === 'turns' && segments.length === 4) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'turn', path } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'POST' && third === 'saved' && segments.length === 4) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'saved_reference_create', path } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'POST' && third === 'decided' && segments.length === 4) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'place_decide', path } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'GET' && segments.length === 3) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'read_thread', path } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'GET' && third === 'replay' && segments.length === 4) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'replay_thread', path } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'DELETE' && segments.length === 3) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'delete_thread', path } }
      : { ok: false, failure: invalidArgument() };
  }
  if (request.method === 'POST' && segments.length === 4 && isLifecycleAction(third)) {
    return url.search.length === 0
      ? { ok: true, route: { kind: 'lifecycle', action: third, path } }
      : { ok: false, failure: invalidArgument() };
  }
  return { ok: false, failure: notFound() };
};
