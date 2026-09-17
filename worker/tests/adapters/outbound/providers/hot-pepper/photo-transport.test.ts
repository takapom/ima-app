import { describe, expect, it, vi } from 'vitest';
import { createHotPepperPhotoTransport } from '@worker/adapters/outbound/providers/hot-pepper/photo-transport';

const URL = 'https://imgfp.hotp.jp/IMGH/00/01/P000000001/P000000001_480.jpg';
const bytes = new Uint8Array([255, 216, 255, 217]);

describe('Hot Pepper photo transport', () => {
  it('fetches an image without credentials or redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })),
    );
    const media = await createHotPepperPhotoTransport({ fetcher }).read(URL);
    expect(new Uint8Array(await new Response(media.body).arrayBuffer())).toEqual(bytes);
    expect(media.contentType).toBe('image/jpeg');
    const call = fetcher.mock.calls[0];
    if (call === undefined) throw new Error('Photo request missing');
    const request = new Request(...call);
    expect(request.url).toBe(URL);
    expect(request.redirect).toBe('manual');
    expect(request.headers.has('authorization')).toBe(false);
  });

  it.each([
    'http://imgfp.hotp.jp/IMGH/a.jpg',
    'https://evil.example/IMGH/a.jpg',
    'https://imgfp.hotp.jp.evil.example/IMGH/a.jpg',
    `${URL}?key=secret`,
    'places/a/photos/b',
  ])('rejects unsafe or legacy references without HTTP: %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createHotPepperPhotoTransport({ fetcher }).read(url)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [302, {}, 'REDIRECT_REJECTED'],
    [404, {}, 'EXPIRED'],
    [503, {}, 'UPSTREAM_UNAVAILABLE'],
    [200, { 'content-type': 'text/html' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [200, { 'content-type': 'image/jpeg', 'content-length': '1000' }, 'RESULT_TOO_LARGE'],
    [200, { 'content-type': 'image/jpeg' }, 'RESULT_TOO_LARGE'],
  ] as const)('rejects bad status, type or bounded body: %s %j', async (status, headers, code) => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(bytes, { status, headers }));
    await expect(
      createHotPepperPhotoTransport({ fetcher, maxBytes: 3 }).read(URL),
    ).rejects.toMatchObject({ code });
  });

  it.each(['timeout', 'cancel'] as const)('stops an upstream request on %s', async (reason) => {
    const controller = new AbortController();
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const result = createHotPepperPhotoTransport({ fetcher, timeoutMs: 5 }).read(
      URL,
      controller.signal,
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED',
    });
    if (reason === 'cancel') controller.abort();
    await assertion;
  });
});
