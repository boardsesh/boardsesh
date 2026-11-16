import { describe, expect, it } from 'vitest';
import { changelogCategoryTone } from '../changelog-category-tone';

describe('changelogCategoryTone', () => {
  it('maps new to neutral, improved to warning and fixed to positive', () => {
    expect(changelogCategoryTone('new')).toBe('neutral');
    expect(changelogCategoryTone('improved')).toBe('warning');
    expect(changelogCategoryTone('fixed')).toBe('positive');
  });
});
