// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SprayEditorHold } from '../spray-hold-editor-reducer';

vi.mock('react-native', () => ({ StyleSheet: { absoluteFill: {} } }));
vi.mock('../../../theme/tokens', () => ({ overlays: { onScrim: '#fff', loupeBackdrop: '#000' } }));
vi.mock('react-native-svg', () => ({
  default: ({
    children,
    testID,
    pointerEvents,
    viewBox,
  }: {
    children?: ReactNode;
    testID?: string;
    pointerEvents?: string;
    viewBox?: string;
  }) => createElement('svg', { 'data-testid': testID, 'data-pointer-events': pointerEvents, viewBox }, children),
  Defs: ({ children }: { children?: ReactNode }) => createElement('defs', null, children),
  Mask: ({ children, id, maskType }: { children?: ReactNode; id?: string; maskType?: string }) =>
    createElement('mask', { id, 'data-mask-type': maskType }, children),
  Path: (props: { d: string; fill: string; fillRule: string }) => createElement('path', props),
  Rect: (props: { width: number; height: number; fill: string; mask?: string }) => createElement('rect', props),
}));

import { SprayHoldsOnlyPreview } from '../SprayHoldsOnlyPreview';

const first: SprayEditorHold = {
  id: 1,
  cx: 100,
  cy: 200,
  r: 20,
  outline: null,
  source: 'MANUAL',
  confidence: null,
  review: 'accepted',
  dirty: true,
};
const size = { boardWidth: 1000, boardHeight: 2000, renderWidth: 300, renderHeight: 600 };

afterEach(cleanup);

describe('SprayHoldsOnlyPreview', () => {
  it('masks the existing photo with one path, without another image or touch surface', () => {
    const holds = Array.from({ length: 1500 }, (_, index) => ({ ...first, id: index + 1, cx: index }));
    const view = render(<SprayHoldsOnlyPreview {...size} holds={holds} />);
    expect(view.getByTestId('spray-holds-only-preview').getAttribute('data-pointer-events')).toBe('none');
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1000 2000');
    expect(view.container.querySelectorAll('path')).toHaveLength(1);
    expect(view.container.querySelector('mask')?.getAttribute('data-mask-type')).toBe('luminance');
    expect(view.container.querySelector('image')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('updates the mask immediately when the ON outlines change', () => {
    const view = render(<SprayHoldsOnlyPreview {...size} holds={[first]} />);
    const originalPath = view.container.querySelector('path')?.getAttribute('d');
    const originalMask = view.container.querySelector('mask')?.id;
    view.rerender(<SprayHoldsOnlyPreview {...size} holds={[{ ...first, r: 40 }]} />);
    expect(view.container.querySelector('path')?.getAttribute('d')).not.toBe(originalPath);
    expect(view.container.querySelector('mask')?.id).toBe(originalMask);
    view.rerender(<SprayHoldsOnlyPreview {...size} holds={[{ ...first, review: 'rejected' }]} />);
    expect(view.container.querySelector('path')?.getAttribute('d')).toBe('');
  });
});
