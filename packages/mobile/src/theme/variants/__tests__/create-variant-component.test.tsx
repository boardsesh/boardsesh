// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, useState } from 'react';

// Controls the resolved variant the factory routes on. createVariantComponent
// reads it through useTheme(); the mock keeps this a pure object (no real hooks),
// so the wrapper's own hook count is constant.
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: ctrl.variant }) }));

import { createVariantComponent } from '../create-variant-component';

type DemoProps = { label: string };

// The glass impl runs TWO hooks; the material impl runs ZERO. If the factory called
// the chosen impl as a plain function (instead of rendering it as JSX), a live
// variant flip would change the hook count *within the wrapper's fiber* and crash
// with "rendered fewer hooks than during the previous render". Rendering as JSX
// gives each impl its own fiber, so a flip is a clean unmount + mount.
function GlassImpl({ label }: DemoProps) {
  const [n] = useState(0);
  useEffect(() => {}, []);
  return createElement('div', { 'data-variant': 'glass', 'data-n': n }, label);
}
function MaterialImpl({ label }: DemoProps) {
  return createElement('div', { 'data-variant': 'material' }, label);
}

const Demo = createVariantComponent<DemoProps>('Demo', { liquidGlass: GlassImpl, material: MaterialImpl });

describe('createVariantComponent', () => {
  it('renders the implementation for the active variant (and passes props through)', () => {
    ctrl.variant = 'liquidGlass';
    const glass = render(createElement(Demo, { label: 'hi' }));
    expect(glass.container.querySelector('[data-variant="glass"]')?.textContent).toBe('hi');
    expect(glass.container.querySelector('[data-variant="material"]')).toBeNull();
    glass.unmount();

    ctrl.variant = 'material';
    const material = render(createElement(Demo, { label: 'hi' }));
    expect(material.container.querySelector('[data-variant="material"]')?.textContent).toBe('hi');
    expect(material.container.querySelector('[data-variant="glass"]')).toBeNull();
  });

  it('sets displayName for DevTools / error overlays', () => {
    expect(Demo.displayName).toBe('Demo');
  });

  it('survives a live variant flip when the two impls have different hook counts', () => {
    ctrl.variant = 'liquidGlass';
    const { container, rerender } = render(createElement(Demo, { label: 'x' }));
    expect(container.querySelector('[data-variant="glass"]')).toBeTruthy();

    // Flip to the zero-hook impl and re-render the SAME element. Because the impl is
    // rendered as JSX (its own fiber), this is an unmount of the 2-hook impl and a
    // mount of the 0-hook impl — it must NOT throw a Rules-of-Hooks error.
    ctrl.variant = 'material';
    expect(() => rerender(createElement(Demo, { label: 'x' }))).not.toThrow();
    expect(container.querySelector('[data-variant="material"]')).toBeTruthy();
    expect(container.querySelector('[data-variant="glass"]')).toBeNull();
  });
});
