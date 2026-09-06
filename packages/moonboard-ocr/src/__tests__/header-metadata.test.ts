import { describe, expect, it } from 'vite-plus/test';
import { parseHeaderText } from '../core/ocr';

describe('metadata distinctions exposed by the old-catalog comparison', () => {
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

  it('preserves different explicitly labelled Android grades', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'User 7A/V6 - Setter 6C+/V5']);
    expect(result.userGrade).toBe('7A/V6');
    expect(result.setterGrade).toBe('6C+/V5');
  });

  it('preserves the legacy iOS grade line', () => {
    const result = parseHeaderText(['SYNTHETIC', 'Set by Setter @ 40°', 'Grade: User 8A/V11/ Setter 8A/V11']);
    expect(result.userGrade).toBe('8A/V11');
    expect(result.setterGrade).toBe('8A/V11');
  });
});
