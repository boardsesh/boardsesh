// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const announce = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: announce },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ brandColors: { error: '#f00' } }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));

import { NameRequiredHint } from '../NameRequiredHint';

describe('NameRequiredHint announcement', () => {
  beforeEach(() => announce.mockClear());

  it('announces on mount and again each time the key bumps, but not on an unrelated re-render', () => {
    const { rerender } = render(createElement(NameRequiredHint, { announceKey: 1 }));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('mobile.create.header.nameRequired');

    rerender(createElement(NameRequiredHint, { announceKey: 1 }));
    expect(announce).toHaveBeenCalledTimes(1);

    rerender(createElement(NameRequiredHint, { announceKey: 2 }));
    expect(announce).toHaveBeenCalledTimes(2);
  });
});
