import { describe, expect, it } from 'vite-plus/test';
import { CreateSprayWallVersionInputSchema } from '../validation/schemas/spray-walls';

const WALL_UUID = '478a7415-0e57-47cb-90e8-493c6c253074';
const PHOTO_ID = '8378744d-76f5-47df-8872-7138f461bf9e';
const ANCHORS = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

describe('a spray wall version photo source', () => {
  it('keeps uploaded-photo requests compatible', () => {
    expect(
      CreateSprayWallVersionInputSchema.parse({ wallUuid: WALL_UUID, photoId: PHOTO_ID, anchors: ANCHORS }),
    ).toMatchObject({ photoId: PHOTO_ID, anchors: ANCHORS });
  });

  it('accepts a published-version id and a null unused photo id', () => {
    expect(
      CreateSprayWallVersionInputSchema.parse({ wallUuid: WALL_UUID, sourceVersionId: '42', photoId: null }),
    ).toMatchObject({ sourceVersionId: 42, photoId: null });
    expect(
      CreateSprayWallVersionInputSchema.safeParse({
        wallUuid: WALL_UUID,
        photoId: PHOTO_ID,
        sourceVersionId: null,
      }).success,
    ).toBe(true);
  });

  it.each([{}, { photoId: null, sourceVersionId: null }, { photoId: PHOTO_ID, sourceVersionId: '42' }])(
    'requires exactly one photo source: %j',
    (sources) => {
      expect(CreateSprayWallVersionInputSchema.safeParse({ wallUuid: WALL_UUID, ...sources }).success).toBe(false);
    },
  );

  it.each([{ anchors: null }, { anchors: ANCHORS }])(
    'rejects supplied anchors when reusing a photo: %j',
    ({ anchors }) => {
      expect(
        CreateSprayWallVersionInputSchema.safeParse({ wallUuid: WALL_UUID, sourceVersionId: '42', anchors }).success,
      ).toBe(false);
    },
  );

  it.each(['missing', '0', '-1', '1.5'])('rejects an invalid source version id: %s', (sourceVersionId) => {
    expect(CreateSprayWallVersionInputSchema.safeParse({ wallUuid: WALL_UUID, sourceVersionId }).success).toBe(false);
  });
});
