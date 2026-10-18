import { describe, expect, it } from 'vitest';
import { boardRowKeys, boardUuidOrNull } from '../board-identity';

const hiddenBoard = (serialNumber: string, overrides: Record<string, unknown> = {}) => ({
  uuid: '',
  serialNumber,
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  angle: 40,
  ...overrides,
});

describe('boardUuidOrNull', () => {
  // A hidden board found by a signed-out serial lookup carries uuid '' (#6375).
  it('reads an empty uuid as no uuid', () => {
    expect(boardUuidOrNull('')).toBeNull();
    expect(boardUuidOrNull(null)).toBeNull();
    expect(boardUuidOrNull(undefined)).toBeNull();
  });

  it('keeps a real uuid', () => {
    expect(boardUuidOrNull('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('boardRowKeys', () => {
  it('keys a board with a uuid on its uuid', () => {
    expect(boardRowKeys([hiddenBoard('751945', { uuid: 'garage' })])).toEqual(['garage']);
  });

  it('gives two hidden boards on different serials different keys', () => {
    const keys = boardRowKeys([hiddenBoard('751945'), hiddenBoard('812002')]);
    expect(keys).toEqual(['geometry:751945:kilter:1:7:1,20:40', 'geometry:812002:kilter:1:7:1,20:40']);
  });

  it('keeps keys unique when two hidden boards share a serial and config', () => {
    const keys = boardRowKeys([hiddenBoard('751945'), hiddenBoard('751945'), hiddenBoard('751945')]);
    expect(new Set(keys).size).toBe(3);
  });

  it('never keys a hidden row on the empty uuid', () => {
    expect(boardRowKeys([hiddenBoard('751945')])).not.toContain('');
  });
});
