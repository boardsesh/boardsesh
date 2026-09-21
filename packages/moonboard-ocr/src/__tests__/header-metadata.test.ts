import { describe, expect, it } from 'vite-plus/test';
import { parseHeaderText } from '../core/ocr';

describe('metadata distinctions exposed by the old-catalog comparison', () => {
  it('keeps the first meaningful title when the setter boundary is missing', () => {
    const result = parseHeaderText(['Small title', 'LONG UPPERCASE OCR ARTIFACT', 'User 7A/V6 - Setter 6C+/V5']);
    expect(result.name).toBe('Small title');
    expect(result.setter).toBe('Unknown');
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('6C+/V5');
    expect(result.warnings).toContain('Could not extract setter name');
  });

  it('does not invent a community grade from the only setter grade', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'Setter 6C+/V5']);
    expect(result.userGrade).toBe('Unknown');
    expect(result.setterGrade).toBe('6C+/V5');
    expect(result.warnings).toContain('Could not extract user grade');
    expect(result.warnings).not.toContain('Could not extract setter grade');
  });

  it('does not invent a setter grade from the only community grade', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 6B/V4']);
    expect(result.userGrade).toBe('6B/V4');
    expect(result.setterGrade).toBe('Unknown');
  });

  it.each(['FRODO', 'FRODO Q'])('preserves a legitimate trailing letter in %s', (title) => {
    const result = parseHeaderText([title, 'Set by Setter @ 40°', 'User 6B/V4 - Setter 6B/V4']);
    expect(result.name).toBe('FRODO');
  });

  it('does not pick a longer star-rating artifact below the setter as the name', () => {
    const result = parseHeaderText(['13.63', 'Set by Setter @ 40°', 'User 6B/V4 - Setter 6B/V4', '8.6.6 $4']);
    expect(result.name).toBe('13.63');
  });

  it('keeps an attached trailing symbol while stripping a separate icon token', () => {
    const metadata = ['Set by Setter @ 40°', 'User 7A/V6 - Setter 6C+/V5'];
    expect(parseHeaderText(['SYNTHETIC@', ...metadata]).name).toBe('SYNTHETIC@');
    expect(parseHeaderText(['SYNTHETIC @', ...metadata]).name).toBe('SYNTHETIC');
  });

  it('preserves different explicitly labelled Android grades', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 7A/V6 - Setter 6C+/V5']);
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('6C+/V5');
  });

  it.each(['User 7A/V6 - Setter 6C+/V5', '7A/V6 6C+/V5'])(
    'reads grade metadata merged onto the setter line: %s',
    (metadata) => {
      const result = parseHeaderText(['SYNTHETIC', `Set by Setter @ 40° ${metadata}`]);
      expect(result.setter).toBe('Setter');
      expect(result.angle).toBe(40);
      expect(result.userGrade).toBe('7A/V6');
      expect(result.setterGrade).toBe('6C+/V5');
    },
  );

  it('does not treat grade-like title or author text as grade metadata', () => {
    const result = parseHeaderText(['8A/V11 PROJECT', 'Set by Setter 6C/V5 @ 40°']);
    expect(result.setter).toBe('Setter 6C/V5');
    expect(result.userGrade).toBe('Unknown');
    expect(result.setterGrade).toBe('Unknown');
  });

  it('keeps the unlabelled grade fallback when the author is named Setter', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', '7A/V6 6C+/V5']);
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('6C+/V5');
  });

  it('accepts explicitly labelled Font-only grades without inventing a V grade', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 7A - Setter 6C+']);
    expect(result.userGrade).toBe('7A');
    expect(result.setterGrade).toBe('6C+');
    expect(result.warnings).toEqual([]);
  });

  it('accepts the legacy slash separator without a space before Setter', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 7A/V6/Setter 6C+/V5']);
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('6C+/V5');
  });

  it('refuses an attached hyphen suffix without backtracking to a partial grade', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 7A/V6-Setter 6C+/V5']);
    expect(result.userGrade).toBe('Unknown');
    expect(result.setterGrade).toBe('6C+/V5');
    expect(result.warnings).toContain('Could not extract user grade');
  });

  it('preserves the legacy iOS grade line', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'Grade: User 8A/V11/ Setter 8A/V11']);
    expect(result.userGrade).toBe('8A/V11');
    expect(result.setterGrade).toBe('8A/V11');
  });

  it('repairs a compressed grade plus without copying the community grade', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 7A/V6 - Setter 6B-+/V4']);
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('6B+/V4');
    expect(result.warnings).toContain('Normalized OCR dash before grade plus');
  });

  it.each(['6B-/V4', '6BC/V4', '2B+/V2'])('does not silently accept the prefix of malformed grade %s', (grade) => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', `User 7A/V6 - Setter ${grade}`]);
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('Unknown');
    expect(result.warnings).toContain('Could not extract setter grade');
  });
});
