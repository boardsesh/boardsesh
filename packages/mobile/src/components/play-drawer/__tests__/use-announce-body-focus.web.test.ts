// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import type { ViewInstance } from 'react-native';
import { useAnnounceBodyFocus } from '../use-announce-body-focus.web';

describe('useAnnounceBodyFocus (web)', () => {
  it('focuses the body element directly — no findNodeHandle, no AccessibilityInfo', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const bodyRef = { current: node as unknown as ViewInstance } as RefObject<ViewInstance | null>;

    renderHook(() => useAnnounceBodyFocus(bodyRef, true));

    expect(document.activeElement).toBe(node);
    expect(node.getAttribute('tabindex')).toBe('-1');
  });

  it('does not overwrite an existing tabindex', () => {
    const node = document.createElement('div');
    node.setAttribute('tabindex', '0');
    document.body.appendChild(node);
    const bodyRef = { current: node as unknown as ViewInstance } as RefObject<ViewInstance | null>;

    renderHook(() => useAnnounceBodyFocus(bodyRef, true));

    expect(node.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(node);
  });

  it('focuses again when the refocus key changes', () => {
    const node = document.createElement('div');
    const other = document.createElement('button');
    document.body.append(node, other);
    const bodyRef = { current: node as unknown as ViewInstance } as RefObject<ViewInstance | null>;

    const hook = renderHook(({ refocusKey }) => useAnnounceBodyFocus(bodyRef, true, refocusKey), {
      initialProps: { refocusKey: 1 },
    });
    other.focus();
    hook.rerender({ refocusKey: 1 });
    expect(document.activeElement).toBe(other);
    hook.rerender({ refocusKey: 2 });
    expect(document.activeElement).toBe(node);
  });

  it('does not throw when the ref has not mounted', () => {
    const bodyRef = { current: null } as RefObject<ViewInstance | null>;
    expect(() => renderHook(() => useAnnounceBodyFocus(bodyRef, true))).not.toThrow();
  });
});
