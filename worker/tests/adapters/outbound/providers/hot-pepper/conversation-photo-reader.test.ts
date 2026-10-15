import { describe, expect, it, vi } from 'vitest';
import { createHotPepperConversationPhotoReader } from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reader';
import { HotPepperError } from '@worker/infrastructure/adapters/out/providers/hot-pepper/types';
import type { HotPepperTransport } from '@worker/infrastructure/adapters/out/providers/hot-pepper/transport';
import type { PhotoMediaTransport } from '@worker/infrastructure/runtime/ports/photo-media';

describe('current conversation photos', () => {
  const shop = {
    id: 'J123',
    name: 'shop',
    lat: null,
    lng: null,
    photo: { pc: { l: 'https://imgfp.hotp.jp/IMGH/01/23/P000000123/P000000123_480.jpg' } },
  };
  const make = () => {
    const search = vi
      .fn<HotPepperTransport['search']>()
      .mockResolvedValue({ shops: [shop], resultsAvailable: 1, resultsStart: 1 });
    const read = vi.fn<PhotoMediaTransport['read']>().mockResolvedValue({
      contentType: 'image/jpeg',
      contentLength: 1,
      body: new ReadableStream(),
    });
    return { search, read, reader: createHotPepperConversationPhotoReader({ search }, { read }) };
  };
  const source = { provider: 'hotpepper', recordRef: 'J123' };
  it('looks up the stored shop ID and uses only the allowlisted photo CDN', async () => {
    const { reader, search, read } = make();
    const signal = new AbortController().signal;
    expect(await reader.read(source, signal)).toMatchObject({ contentType: 'image/jpeg' });
    expect(search).toHaveBeenCalledWith({ id: ['J123'], count: 1 }, signal);
    expect(read).toHaveBeenCalledWith(shop.photo.pc.l, signal);
  });
  it('separates no photo, missing shop, source mismatch and transport failure', async () => {
    const { reader, search, read } = make();
    search.mockResolvedValueOnce({ shops: [], resultsAvailable: 0, resultsStart: 1 });
    expect(await reader.read(source)).toBeNull();
    search.mockResolvedValueOnce({
      shops: [{ ...shop, photo: null }],
      resultsAvailable: 1,
      resultsStart: 1,
    });
    expect(await reader.read(source)).toBeNull();
    search.mockResolvedValueOnce({
      shops: [{ ...shop, id: 'J999' }],
      resultsAvailable: 1,
      resultsStart: 1,
    });
    await expect(reader.read(source)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    search.mockRejectedValueOnce(new HotPepperError('TIMEOUT'));
    await expect(reader.read(source)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects a shop id outside the photo reference before any provider call', async () => {
    const { reader, search, read } = make();
    await expect(reader.read({ provider: 'hotpepper', recordRef: 'shop-1' })).rejects.toMatchObject(
      { code: 'INVALID_REQUEST' },
    );
    await expect(reader.read({ provider: 'example', recordRef: 'J123' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(
      reader.read({ provider: 'hotpepper', recordRef: `J${'1'.repeat(128)}` }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(search).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
