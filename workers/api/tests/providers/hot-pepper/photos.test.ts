import { describe, expect, it } from 'vitest';
import { makeFixture, place, read, readInput } from './adapter-fixtures';

const LARGE = 'https://imgfp.hotp.jp/IMGH/00/01/P000000001/P000000001_480.jpg';
const SMALL = 'https://imgfp.hotp.jp/IMGH/00/01/P000000001/P000000001_168.jpg';

describe('Hot Pepper store photos', () => {
  it.each([
    { l: LARGE, m: SMALL, s: SMALL },
    { l: null, m: LARGE },
    { l: 'https://untrusted.example/photo.jpg', s: LARGE },
  ])('selects one largest available safe image with attribution: %j', async (pc) => {
    const f = makeFixture();
    f.setBody((id) => ({ ...place(id), photo: { pc } }));
    const candidateId = f.candidateIds[0];
    if (candidateId === undefined) throw new Error('Candidate missing');
    expect(await read(f, readInput(candidateId, ['photos']))).toMatchObject({
      status: 'ok',
      data: {
        items: [
          {
            fields: {
              photos: {
                status: 'known',
                observations: [
                  {
                    field: 'photos',
                    value: {
                      photos: [
                        {
                          photoRef: LARGE,
                          sourceUrl: 'https://www.hotpepper.jp/strplace-a/',
                          attributions: [
                            {
                              displayName: 'ホットペッパー グルメ',
                              uri: 'https://www.hotpepper.jp/strplace-a/',
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    });
    expect(f.calls).toHaveLength(1);
    await read(f, readInput(candidateId, ['photos'], 'reuse_valid'));
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    undefined,
    null,
    {},
    { pc: {} },
    { pc: { l: '' } },
    { pc: { l: 'https://evil.example/photo.jpg' } },
  ])('keeps the store available when its photo is missing or unusable: %j', async (photo) => {
    const f = makeFixture();
    f.setBody((id) => ({ ...place(id), ...(photo === undefined ? {} : { photo }) }));
    const candidateId = f.candidateIds[0];
    if (candidateId === undefined) throw new Error('Candidate missing');
    const result = await read(f, readInput(candidateId, ['identity', 'photos']));
    expect(result).toMatchObject({
      data: {
        items: [
          {
            fields: {
              identity: { status: 'known' },
              photos: { status: 'unknown' },
            },
          },
        ],
      },
    });
  });
});
