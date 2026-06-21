// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: ctrl.variant }) }));

import { useVariantValue } from '../use-variant-value';

function Probe() {
  const value = useVariantValue({ liquidGlass: 'glass-value', material: 'material-value' });
  return createElement('div', { 'data-value': value });
}

describe('useVariantValue', () => {
  it('returns the value for the active variant', () => {
    ctrl.variant = 'liquidGlass';
    const glass = render(createElement(Probe));
    expect(glass.container.querySelector('div')?.getAttribute('data-value')).toBe('glass-value');
    glass.unmount();

    ctrl.variant = 'material';
    const material = render(createElement(Probe));
    expect(material.container.querySelector('div')?.getAttribute('data-value')).toBe('material-value');
  });

  it('updates the returned value on a live variant flip (re-render, no remount)', () => {
    ctrl.variant = 'liquidGlass';
    const { container, rerender } = render(createElement(Probe));
    expect(container.querySelector('div')?.getAttribute('data-value')).toBe('glass-value');

    // Flip the variant and re-render the SAME mounted tree — the reactive case a
    // misplaced useMemo would regress. The value must track the new variant.
    ctrl.variant = 'material';
    rerender(createElement(Probe));
    expect(container.querySelector('div')?.getAttribute('data-value')).toBe('material-value');
  });
});
