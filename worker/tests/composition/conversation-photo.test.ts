import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredConversationPhotos } from '@worker/composition/bootstrap-photo';

const config = {
  HOTPEPPER_API_KEY: 'fixture-key',
  IMA_RUNTIME_MODE: 'live',
  IMA_PROVIDER_HOTPEPPER: 'true',
  IMA_PROVIDER_PLACES: 'false',
  IMA_KILL_SWITCH: 'false',
};
afterEach(() => vi.unstubAllGlobals());
describe('configured history photos', () => {
  it('uses the active Hot Pepper flag independently of the retired places flag', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          results: {
            shop: [
              {
                id: 'J123',
                name: 'shop',
                lat: null,
                lng: null,
                photo: { pc: { l: 'https://imgfp.hotp.jp/IMGH/photo.jpg' } },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await createConfiguredConversationPhotos(config).read('J123');
    expect(result?.contentType).toBe('image/jpeg');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await result?.body.cancel();
  });
  it.each([
    { ...config, IMA_KILL_SWITCH: 'true' },
    { ...config, IMA_PROVIDER_HOTPEPPER: 'false' },
    { ...config, IMA_RUNTIME_MODE: 'fixture' },
  ])('fails closed without calling the provider when stopped', async (env) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(createConfiguredConversationPhotos(env).read('J123')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
