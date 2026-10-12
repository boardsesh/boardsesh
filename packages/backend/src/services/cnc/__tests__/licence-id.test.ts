import { describe, it, expect } from 'vite-plus/test';
import { LICENCE_ID_ALPHABET, generateLicenceId, isLicenceId } from '../licence-id';

describe('generateLicenceId', () => {
  it('produces the documented BS-CNC-XXXXXX shape', () => {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const licenceId = generateLicenceId();
      expect(licenceId).toMatch(/^BS-CNC-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
      expect(isLicenceId(licenceId)).toBe(true);
    }
  });

  it('never emits a character that gets misread off a routed panel', () => {
    const confusable = ['0', 'O', '1', 'I', 'L', 'U'];
    for (const character of confusable) {
      expect(LICENCE_ID_ALPHABET).not.toContain(character);
    }
    expect(LICENCE_ID_ALPHABET).toHaveLength(30);
    expect(new Set(LICENCE_ID_ALPHABET).size).toBe(30);
  });

  it('draws on the whole alphabet rather than a narrow slice', () => {
    // 2000 ids is 12000 draws over 30 symbols — every symbol appearing is
    // overwhelmingly likely under a uniform source and effectively impossible
    // if the generator were stuck on a subrange.
    const seen = new Set<string>();
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      for (const character of generateLicenceId().slice('BS-CNC-'.length)) seen.add(character);
    }
    expect(seen.size).toBe(LICENCE_ID_ALPHABET.length);
  });

  it('does not repeat itself over a realistic order volume', () => {
    const generated = new Set<string>();
    for (let iteration = 0; iteration < 5000; iteration += 1) generated.add(generateLicenceId());
    // ~29.4 bits of space, so 5000 draws expect well under one collision;
    // a generator with a short period or a fixed seed fails this loudly.
    expect(generated.size).toBeGreaterThanOrEqual(4995);
  });
});

describe('isLicenceId', () => {
  it('accepts a well-formed id', () => {
    expect(isLicenceId('BS-CNC-ABC234')).toBe(true);
  });

  it.each([
    ['bs-cnc-ABC234', 'lowercase prefix'],
    ['BS-CNC-ABC23', 'too short'],
    ['BS-CNC-ABC2345', 'too long'],
    ['BS-CNC-ABC23O', 'excluded character O'],
    ['BS-CNC-ABC23I', 'excluded character I'],
    ['BS-CNC-abc234', 'lowercase body'],
    ['ABC234', 'no prefix'],
    ['BS-CNC-ABC234 ', 'trailing space'],
    ['BS-CNC-ABC234\nBS-CNC-ZZZ999', 'newline injection'],
    ['BS-CNC-ABC234\n', 'trailing newline the $ anchor alone would allow'],
  ])('rejects %s (%s)', (value) => {
    expect(isLicenceId(value)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [['BS-CNC-ABC234']]])('rejects the non-string %p', (value) => {
    expect(isLicenceId(value)).toBe(false);
  });
});
