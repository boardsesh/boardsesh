import { describe, it, expect } from 'vitest';
import { sectionHeaderText } from '../section-header-text';

const colors = { secondaryLabel: 'secondaryLabel', onSurfaceVariant: 'onSurfaceVariant' };

// One header type for SectionHeader and the gym directory's in-list headers.
describe('sectionHeaderText', () => {
  it('is footnote semibold in secondaryLabel on Liquid Glass (HIG Lists)', () => {
    expect(sectionHeaderText('liquidGlass', colors)).toEqual({
      textVariant: 'footnote',
      color: 'secondaryLabel',
      fontWeight: '600',
    });
  });

  it('is titleSmall (14/500) in onSurfaceVariant on Material (M3 Lists)', () => {
    expect(sectionHeaderText('material', colors)).toEqual({
      textVariant: 'subheadline',
      color: 'onSurfaceVariant',
      fontWeight: '500',
    });
  });
});
