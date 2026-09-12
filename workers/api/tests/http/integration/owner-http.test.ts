import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  parsePrefsReadResponse,
  parsePrefsWriteResponse,
  parseSavedReferenceListResponse,
  PublicErrorSchema,
  type Preferences,
} from '@ima/contracts';
import * as v from 'valibot';

const APP_TOKEN = 'test-app-token';

const prefs: Preferences = {
  homeStationRef: 'station-shibuya',
  maxWalkMinutes: 15,
  minimumStayMinutes: null,
  areaText: '恵比寿',
  budget: 'normal',
};

const ownerCredential = (): string => {
  const seed = crypto.randomUUID().replaceAll('-', '');
  return `${seed}${'A'.repeat(42)}`.slice(0, 42) + 'E';
};

const headers = (owner: string, requestId: string, extra?: HeadersInit): HeadersInit => ({
  'x-app-token': APP_TOKEN,
  'x-device-id': `device-${requestId}`,
  'x-ima-owner-credential': owner,
  'x-ima-request-id': requestId,
  'x-app-version': 'm37-test',
  ...extra,
});

const call = (
  path: string,
  owner: string,
  requestId: string,
  init: RequestInit = {},
): Promise<Response> => {
  const requestHeaders = new Headers(headers(owner, requestId, init.headers));
  return SELF.fetch(`https://ima.test${path}`, { ...init, headers: requestHeaders });
};

describe('owner HTTP through Worker bootstrap', () => {
  it('reads unsaved prefs, writes at revision 0, and lists opaque saved refs', async () => {
    const owner = ownerCredential();
    const unreadId = `unread-${crypto.randomUUID()}`;
    const unread = await call('/v1/prefs', owner, unreadId);
    expect(unread.status).toBe(200);
    const unreadBody = parsePrefsReadResponse(await unread.json());
    expect(unreadBody.success).toBe(true);
    if (!unreadBody.success) throw new Error('expected prefs read');
    expect(unreadBody.data).toEqual({
      schemaVersion: 'v1',
      requestId: unreadId,
      revision: 0,
      prefs: null,
    });

    const writeId = `write-${crypto.randomUUID()}`;
    const written = await call('/v1/prefs', owner, writeId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: writeId,
        expectedRevision: 0,
        prefs,
      }),
    });
    expect(written.status).toBe(200);
    const writtenBody = parsePrefsWriteResponse(await written.json());
    expect(writtenBody.success).toBe(true);
    if (!writtenBody.success) throw new Error('expected prefs write');
    expect(writtenBody.data).toEqual({
      schemaVersion: 'v1',
      requestId: writeId,
      revision: 1,
    });

    const readId = `read-${crypto.randomUUID()}`;
    const read = await call('/v1/prefs', owner, readId);
    const readBody = parsePrefsReadResponse(await read.json());
    expect(read.status).toBe(200);
    expect(readBody.success).toBe(true);
    if (!readBody.success) throw new Error('expected restored prefs');
    expect(readBody.data).toEqual({
      schemaVersion: 'v1',
      requestId: readId,
      revision: 1,
      prefs,
    });

    const staleId = `stale-${crypto.randomUUID()}`;
    const stale = await call('/v1/prefs', owner, staleId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: staleId,
        expectedRevision: 0,
        prefs: { ...prefs, budget: 'cheap' },
      }),
    });
    expect(stale.status).toBe(409);
    const staleError = v.safeParse(PublicErrorSchema, await stale.json());
    expect(staleError.success).toBe(true);
    if (!staleError.success) throw new Error('expected public error');
    expect(staleError.output.code).toBe('CONFLICT');

    const listId = `list-${crypto.randomUUID()}`;
    const listed = await call('/v1/saved', owner, listId);
    expect(listed.status).toBe(200);
    const listedBody = parseSavedReferenceListResponse(await listed.json());
    expect(listedBody.success).toBe(true);
    if (!listedBody.success) throw new Error('expected saved list');
    expect(listedBody.data).toEqual({
      schemaVersion: 'v1',
      requestId: listId,
      savedPlaceRefs: [],
    });
    expect(listedBody.data).not.toHaveProperty('provider');
    expect(listedBody.data).not.toHaveProperty('recordRef');
  });
});
