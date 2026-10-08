// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// HIG Accessibility > Large Content Viewer: capped chrome labels hand their words
// to the native viewer on iOS, and are a plain View everywhere else.

const state = vi.hoisted(() => ({
  native: null as null | ((props: Record<string, unknown>) => ReactNode),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID, 'data-kind': 'plain' }, children),
}));

vi.mock('../../../modules/accessibility-ui/src/index', () => ({
  get NativeLargeContentViewer() {
    return state.native;
  },
}));

const nativeProps: Record<string, unknown>[] = [];
function FakeNativeViewer(props: Record<string, unknown>) {
  nativeProps.push(props);
  return createElement(
    'div',
    { 'data-testid': props.testID as string, 'data-kind': 'native' },
    props.children as ReactNode,
  );
}

async function renderViewer(onActivate?: () => void) {
  const { LargeContentViewer } = await import('../LargeContentViewer');
  render(
    createElement(LargeContentViewer, {
      title: 'Moonlight V5',
      onActivate,
      testID: 'viewer',
      children: createElement('span', null, 'label'),
    }),
  );
  return screen.getByTestId('viewer');
}

beforeEach(() => {
  vi.resetModules();
  nativeProps.length = 0;
  state.native = FakeNativeViewer;
});

describe('LargeContentViewer', () => {
  it('hands the title and the activate handler to the native view on iOS', async () => {
    const onActivate = vi.fn();
    const viewer = await renderViewer(onActivate);

    expect(viewer.dataset.kind).toBe('native');
    expect(screen.getByText('label')).toBeTruthy();
    expect(nativeProps[0]?.title).toBe('Moonlight V5');
    const activate = nativeProps[0]?.onLargeContentViewerActivate;
    expect(typeof activate).toBe('function');
    (activate as () => void)();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('sends no activate handler when the bar has nothing to do on lift', async () => {
    await renderViewer();

    expect(nativeProps[0]?.onLargeContentViewerActivate).toBeUndefined();
  });

  it('is a plain View without the module (Android, the web, older binaries)', async () => {
    state.native = null;
    const viewer = await renderViewer();

    expect(viewer.dataset.kind).toBe('plain');
    expect(screen.getByText('label')).toBeTruthy();
  });
});
