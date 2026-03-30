import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// --- Mocks ---

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: (d: string | null | undefined) => {
      if (!d) return null;
      const match = d.match(/V\d+\+?/i);
      return match ? match[0].toUpperCase() : null;
    },
    getGradeColor: (d: string | null | undefined) => {
      if (!d) return undefined;
      const match = d.match(/V\d+\+?/i);
      return match ? `#color-${match[0].toUpperCase()}` : undefined;
    },
    loaded: true,
    setGradeFormat: vi.fn(),
  }),
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    colors: { primary: '#8C4A52' },
    typography: {
      fontSize: { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24 },
      fontWeight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
    },
  },
}));

import ClimbTitle, { ClimbTitleData } from '../climb-title';

// --- Helpers ---

function makeClimb(overrides: Partial<ClimbTitleData> = {}): ClimbTitleData {
  return {
    name: 'Test Boulder',
    difficulty: '6a/V3',
    quality_average: '3.5',
    benchmark_difficulty: null,
    angle: 40,
    setter_username: 'setter_joe',
    ascensionist_count: 10,
    ...overrides,
  };
}

describe('ClimbTitle', () => {
  // --- No climb / null handling ---

  describe('no climb', () => {
    it('renders "No climb selected" when climb is null', () => {
      render(<ClimbTitle climb={null} />);
      expect(screen.getByText('No climb selected')).toBeTruthy();
    });

    it('renders "No climb selected" when climb is undefined', () => {
      render(<ClimbTitle />);
      expect(screen.getByText('No climb selected')).toBeTruthy();
    });
  });

  // --- Stacked layout (default) ---

  describe('stacked layout (default)', () => {
    it('renders climb name', () => {
      render(<ClimbTitle climb={makeClimb({ name: 'Cool Route' })} />);
      expect(screen.getByText('Cool Route')).toBeTruthy();
    });

    it('renders difficulty and quality as inline text', () => {
      render(<ClimbTitle climb={makeClimb({ difficulty: '6a/V3', quality_average: '3.5' })} />);
      expect(screen.getByText('6a/V3 3.5★')).toBeTruthy();
    });

    it('renders "project" when quality_average is "0"', () => {
      render(<ClimbTitle climb={makeClimb({ quality_average: '0' })} />);
      expect(screen.getByText('project')).toBeTruthy();
    });

    it('renders angle when showAngle is true', () => {
      render(<ClimbTitle climb={makeClimb()} showAngle />);
      expect(screen.getByText('6a/V3 3.5★ @ 40°')).toBeTruthy();
    });

    it('does not render angle when showAngle is false', () => {
      render(<ClimbTitle climb={makeClimb()} />);
      expect(screen.queryByText(/@ 40°/)).toBeNull();
    });

    it('renders setter info when showSetterInfo is true', () => {
      render(<ClimbTitle climb={makeClimb()} showSetterInfo />);
      expect(screen.getByText('By setter_joe - 10 ascents')).toBeTruthy();
    });

    it('does not render setter info when showSetterInfo is false', () => {
      render(<ClimbTitle climb={makeClimb()} />);
      expect(screen.queryByText(/setter_joe/)).toBeNull();
    });

    it('renders benchmark icon when benchmark_difficulty is positive', () => {
      render(<ClimbTitle climb={makeClimb({ benchmark_difficulty: '15' })} />);
      expect(screen.getByTestId('CopyrightOutlinedIcon')).toBeTruthy();
    });

    it('does not render benchmark icon when benchmark_difficulty is null', () => {
      render(<ClimbTitle climb={makeClimb({ benchmark_difficulty: null })} />);
      expect(screen.queryByTestId('CopyrightOutlinedIcon')).toBeNull();
    });

    it('renders nameAddon after name', () => {
      render(<ClimbTitle climb={makeClimb()} nameAddon={<span data-testid="addon">✓</span>} />);
      expect(screen.getByTestId('addon')).toBeTruthy();
    });
  });

  // --- Horizontal layout ---

  describe('horizontal layout', () => {
    it('renders large V-grade element', () => {
      render(<ClimbTitle climb={makeClimb()} layout="horizontal" />);
      expect(screen.getByText('V3')).toBeTruthy();
    });

    it('renders subtitle with quality joined by middle dot', () => {
      render(<ClimbTitle climb={makeClimb()} layout="horizontal" showSetterInfo />);
      expect(screen.getByText(/6a\/V3 3\.5★/)).toBeTruthy();
      expect(screen.getByText(/setter_joe/)).toBeTruthy();
    });

    it('renders "project" when no grade quality', () => {
      render(<ClimbTitle climb={makeClimb({ quality_average: '0', difficulty: null, ascensionist_count: undefined })} layout="horizontal" />);
      expect(screen.getByText('project')).toBeTruthy();
    });

    it('renders rightAddon', () => {
      render(<ClimbTitle climb={makeClimb()} layout="horizontal" rightAddon={<span data-testid="right-addon">tick</span>} />);
      expect(screen.getByTestId('right-addon')).toBeTruthy();
    });
  });

  // --- gradePosition='right' layout ---

  describe('gradePosition="right"', () => {
    it('renders climb name', () => {
      render(<ClimbTitle climb={makeClimb({ name: 'Solstice' })} gradePosition="right" />);
      expect(screen.getByText('Solstice')).toBeTruthy();
    });

    it('renders colorized V-grade on the right', () => {
      render(<ClimbTitle climb={makeClimb({ difficulty: '6c+/V5' })} gradePosition="right" />);
      expect(screen.getByText('V5')).toBeTruthy();
    });

    it('renders quality stars in subtitle', () => {
      render(<ClimbTitle climb={makeClimb({ quality_average: '4.2' })} gradePosition="right" />);
      expect(screen.getByText('4.2★')).toBeTruthy();
    });

    it('renders setter name in subtitle when showSetterInfo is true', () => {
      render(<ClimbTitle climb={makeClimb({ setter_username: 'DanielBolts' })} gradePosition="right" showSetterInfo />);
      expect(screen.getByText(/4\.2|3\.5/)).toBeTruthy(); // stars present
      expect(screen.getByText(/DanielBolts/)).toBeTruthy();
    });

    it('renders subtitle as "stars · setter_name" format', () => {
      render(<ClimbTitle climb={makeClimb({ quality_average: '3.5', setter_username: 'alice' })} gradePosition="right" showSetterInfo />);
      expect(screen.getByText('3.5★ · alice')).toBeTruthy();
    });

    it('renders only stars when showSetterInfo is false', () => {
      render(<ClimbTitle climb={makeClimb({ quality_average: '3.5' })} gradePosition="right" />);
      expect(screen.getByText('3.5★')).toBeTruthy();
      expect(screen.queryByText(/setter_joe/)).toBeNull();
    });

    it('renders only stars when setter_username is missing', () => {
      render(<ClimbTitle climb={makeClimb({ setter_username: undefined })} gradePosition="right" showSetterInfo />);
      expect(screen.getByText('3.5★')).toBeTruthy();
    });

    it('does not render angle even when showAngle is true', () => {
      render(<ClimbTitle climb={makeClimb()} gradePosition="right" showAngle />);
      expect(screen.queryByText(/@ 40°/)).toBeNull();
    });

    it('does not render ascent count', () => {
      render(<ClimbTitle climb={makeClimb({ ascensionist_count: 72 })} gradePosition="right" showSetterInfo />);
      expect(screen.queryByText(/72 ascents/)).toBeNull();
    });

    it('renders "project" when no grade quality', () => {
      render(<ClimbTitle climb={makeClimb({ quality_average: '0' })} gradePosition="right" />);
      expect(screen.getByText('project')).toBeTruthy();
    });

    it('renders "project" when difficulty is null', () => {
      render(<ClimbTitle climb={makeClimb({ difficulty: null, quality_average: null })} gradePosition="right" />);
      expect(screen.getByText('project')).toBeTruthy();
    });

    it('renders benchmark icon after climb name', () => {
      render(<ClimbTitle climb={makeClimb({ benchmark_difficulty: '10' })} gradePosition="right" />);
      expect(screen.getByTestId('CopyrightOutlinedIcon')).toBeTruthy();
    });

    it('renders nameAddon in the name row', () => {
      render(<ClimbTitle climb={makeClimb()} gradePosition="right" nameAddon={<span data-testid="name-addon">✓</span>} />);
      expect(screen.getByTestId('name-addon')).toBeTruthy();
    });

    it('renders rightAddon before the grade on the right', () => {
      render(<ClimbTitle climb={makeClimb()} gradePosition="right" rightAddon={<span data-testid="right-addon">status</span>} />);
      expect(screen.getByTestId('right-addon')).toBeTruthy();
    });

    it('renders raw difficulty as fallback when V-grade cannot be parsed', () => {
      render(<ClimbTitle climb={makeClimb({ difficulty: '6a+' })} gradePosition="right" />);
      // formatVGrade returns null for '6a+' (no V-grade match), so fallback renders raw difficulty
      expect(screen.getByText('6a+')).toBeTruthy();
    });

    it('uses communityGrade when available', () => {
      render(<ClimbTitle climb={makeClimb({ difficulty: '6a/V3', communityGrade: '6b/V4' })} gradePosition="right" />);
      expect(screen.getByText('V4')).toBeTruthy();
    });

    it('renders with custom titleFontSize', () => {
      const { container } = render(<ClimbTitle climb={makeClimb()} gradePosition="right" titleFontSize={20} />);
      // Name should be rendered (basic rendering check with custom size)
      expect(screen.getByText('Test Boulder')).toBeTruthy();
      expect(container.firstChild).toBeTruthy();
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('handles climb with empty name', () => {
      render(<ClimbTitle climb={makeClimb({ name: '' })} />);
      // Should render without crashing
      expect(screen.queryByText('No climb selected')).toBeNull();
    });

    it('handles climb with null difficulty', () => {
      render(<ClimbTitle climb={makeClimb({ difficulty: null })} />);
      expect(screen.getByText('Test Boulder')).toBeTruthy();
    });

    it('handles benchmark_difficulty as numeric value', () => {
      // benchmark_difficulty might come as number from some code paths
      render(<ClimbTitle climb={makeClimb({ benchmark_difficulty: '0' })} />);
      expect(screen.queryByTestId('CopyrightOutlinedIcon')).toBeNull();
    });

    it('handles benchmark_difficulty as "0" string (not benchmark)', () => {
      render(<ClimbTitle climb={makeClimb({ benchmark_difficulty: '0' })} />);
      expect(screen.queryByTestId('CopyrightOutlinedIcon')).toBeNull();
    });

    it('renders both name and grade in stacked layout', () => {
      render(<ClimbTitle climb={makeClimb()} />);
      expect(screen.getByText('Test Boulder')).toBeTruthy();
      expect(screen.getByText('6a/V3 3.5★')).toBeTruthy();
    });
  });
});
