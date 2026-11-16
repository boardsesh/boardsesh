// @vitest-environment jsdom
// The Velvet Send v2 Text roles: the emphasized weight, and the label tone that
// replaces opacity dims.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { materialTextStyles, textStyles } from '../../theme/typography';

const ctrl = vi.hoisted(() => ({
  bold: false,
  theme: null as null | {
    variant: 'liquidGlass' | 'material';
    textStyles: Record<string, unknown>;
    systemColors: Record<string, string>;
  },
}));

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

vi.mock('react-native', () => ({
  Text: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'span',
      {
        'data-weight': flatten(style).fontWeight,
        'data-color': flatten(style).color ?? 'none',
      },
      children,
    ),
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    flatten: (style: unknown) => flatten(style),
  },
}));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => ctrl.bold }));
vi.mock('../../providers/theme-provider', () => ({ useOptionalTheme: () => ctrl.theme }));

import { Text } from '../Text';

const systemColors = { label: '#LABEL', secondaryLabel: '#SECONDARY', tertiaryLabel: '#TERTIARY' };

beforeEach(() => {
  ctrl.bold = false;
  ctrl.theme = { variant: 'liquidGlass', textStyles, systemColors };
});

describe('Text emphasized', () => {
  it('takes the HIG emphasized weight on Liquid Glass', () => {
    const { getByText } = render(
      <>
        <Text variant="body" emphasized>
          Body
        </Text>
        <Text variant="footnote" emphasized>
          Footnote
        </Text>
        <Text variant="title2" emphasized>
          Title
        </Text>
        <Text variant="body">Plain</Text>
      </>,
    );
    expect(getByText('Body').getAttribute('data-weight')).toBe('600');
    expect(getByText('Footnote').getAttribute('data-weight')).toBe('600');
    expect(getByText('Title').getAttribute('data-weight')).toBe('700');
    expect(getByText('Plain').getAttribute('data-weight')).toBe('400');
  });

  it('takes the M3 emphasized weight on Material', () => {
    ctrl.theme = { variant: 'material', textStyles: materialTextStyles, systemColors };
    const { getByText } = render(
      <>
        <Text variant="body" emphasized>
          Body
        </Text>
        <Text variant="headline" emphasized>
          Headline
        </Text>
      </>,
    );
    expect(getByText('Body').getAttribute('data-weight')).toBe('500');
    expect(getByText('Headline').getAttribute('data-weight')).toBe('700');
  });

  it("lets a caller's own fontWeight win", () => {
    const { getByText } = render(
      <Text variant="body" emphasized style={{ fontWeight: '500' }}>
        Body
      </Text>,
    );
    expect(getByText('Body').getAttribute('data-weight')).toBe('500');
  });

  it('steps the emphasized weight up once more under Bold Text', () => {
    ctrl.bold = true;
    const { getByText } = render(
      <>
        <Text variant="body" emphasized>
          Emphasized
        </Text>
        <Text variant="body">Regular</Text>
      </>,
    );
    expect(getByText('Emphasized').getAttribute('data-weight')).toBe('700');
    expect(getByText('Regular').getAttribute('data-weight')).toBe('500');
  });

  it('uses the HIG weights without a provider', () => {
    ctrl.theme = null;
    const { getByText } = render(
      <Text variant="subheadline" emphasized>
        Body
      </Text>,
    );
    expect(getByText('Body').getAttribute('data-weight')).toBe('600');
  });
});

describe('Text tone', () => {
  it('maps primary, secondary and tertiary to the label colours', () => {
    const { getByText } = render(
      <>
        <Text>Default</Text>
        <Text tone="primary">Primary</Text>
        <Text tone="secondary">Secondary</Text>
        <Text tone="tertiary">Tertiary</Text>
      </>,
    );
    expect(getByText('Default').getAttribute('data-color')).toBe('#LABEL');
    expect(getByText('Primary').getAttribute('data-color')).toBe('#LABEL');
    expect(getByText('Secondary').getAttribute('data-color')).toBe('#SECONDARY');
    expect(getByText('Tertiary').getAttribute('data-color')).toBe('#TERTIARY');
  });

  it('lets an explicit color win over the tone', () => {
    const { getByText } = render(
      <Text tone="secondary" color="#EXPLICIT">
        Colour
      </Text>,
    );
    expect(getByText('Colour').getAttribute('data-color')).toBe('#EXPLICIT');
  });

  it('lets a style colour win over the tone', () => {
    const { getByText } = render(
      <Text tone="tertiary" style={{ color: '#STYLE' }}>
        Colour
      </Text>,
    );
    expect(getByText('Colour').getAttribute('data-color')).toBe('#STYLE');
  });

  it('leaves the colour to React Native without a provider', () => {
    ctrl.theme = null;
    const { getByText } = render(<Text tone="secondary">Colour</Text>);
    expect(getByText('Colour').getAttribute('data-color')).toBe('none');
  });
});
