// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ComponentStory, RegisteredStory, StoryRenderControls } from '../types';

const fixture = vi.hoisted(() => ({
  story: null as RegisteredStory | null,
  shot: 'first',
  focused: true,
  rendererReady: true,
  captureOrientation: undefined as string | undefined,
  width: 400,
  height: 800,
}));
vi.mock('../../fixtures/board-render-style', () => ({ useStoryRendererReady: () => fixture.rendererReady }));
vi.mock('../registry', () => ({
  loadStory: () => fixture.story,
  loadStories: () => [],
  storyModuleIds: () => [],
}));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: fixture.width, height: fixture.height }),
  Platform: { OS: 'android' },
  View: ({ children, onLayout }: { children: ReactNode; onLayout?: () => void }) => (
    <div data-testid={onLayout ? 'canvas' : undefined} onClick={onLayout}>
      {children}
    </div>
  ),
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    id: 'sample--loaded',
    shot: fixture.shot,
    captureOrientation: fixture.captureOrientation,
  }),
  useFocusEffect: () => undefined,
  useIsFocused: () => fixture.focused,
  Redirect: () => <div data-testid="redirect" />,
  Stack: { Screen: () => <span data-testid="harness-header-options" /> },
  router: { replace: vi.fn(), push: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../components/Text', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../use-story-appearance', () => ({ useStoryAppearance: () => undefined }));

import { StoryScreen } from '../screens';

let controls: StoryRenderControls;
function installStory(readiness: ComponentStory['readiness']) {
  fixture.story = {
    id: 'sample--loaded',
    moduleId: 'sample',
    title: 'Sample',
    order: 0,
    story: {
      name: 'Loaded',
      readiness,
      render: (nextControls) => {
        controls = nextControls;
        return <span>Content</span>;
      },
    },
  };
}

beforeEach(() => {
  fixture.shot = 'first';
  fixture.focused = true;
  fixture.rendererReady = true;
  fixture.captureOrientation = undefined;
  fixture.width = 400;
  fixture.height = 800;
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function flushPaints() {
  act(() => {
    vi.runAllTimers();
  });
}

describe('story capture readiness', () => {
  it('mounts no content until final orientation, then requires assets and layout', () => {
    installStory('explicit');
    fixture.captureOrientation = 'landscape';
    const renderContent = vi.spyOn(fixture.story!.story, 'render');
    const screen = render(<StoryScreen />);
    flushPaints();
    expect(renderContent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('canvas')).toBeNull();
    fixture.width = 800;
    fixture.height = 400;
    screen.rerender(<StoryScreen />);
    fireEvent.click(screen.getByTestId('canvas'));
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    act(() => controls.onReady());
    flushPaints();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[stories] ready sample--loaded');
  });

  it('discards old readiness when orientation no longer matches and content remounts', () => {
    installStory('explicit');
    fixture.captureOrientation = 'portrait';
    const screen = render(<StoryScreen />);
    const oldControls = controls;
    fixture.width = 800;
    fixture.height = 400;
    screen.rerender(<StoryScreen />);
    act(() => oldControls.onReady());
    fixture.width = 400;
    fixture.height = 800;
    screen.rerender(<StoryScreen />);
    fireEvent.click(screen.getByTestId('canvas'));
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    act(() => controls.onReady());
    flushPaints();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[stories] ready sample--loaded');
  });
  it('waits for the requested renderer even after content and layout are ready', () => {
    installStory('explicit');
    fixture.rendererReady = false;
    const screen = render(<StoryScreen />);
    fireEvent.click(screen.getByTestId('canvas'));
    act(() => controls.onReady());
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    fixture.rendererReady = true;
    screen.rerender(<StoryScreen />);
    flushPaints();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[stories] ready sample--loaded');
  });

  it('leaves native header options to tab views while hiding the standalone story header', () => {
    installStory('layout');
    fixture.story!.story.layout = 'fullscreen';
    const screen = render(<StoryScreen />);
    expect(screen.getByTestId('harness-header-options')).toBeTruthy();
    fixture.story!.story.tab = 'home';
    screen.rerender(<StoryScreen inTab tab="home" />);
    expect(screen.queryByTestId('harness-header-options')).toBeNull();
    expect(screen.getByText('Content')).toBeTruthy();
  });

  it('never reports readiness for a preloaded inactive tab', () => {
    installStory('layout');
    fixture.focused = false;
    const screen = render(<StoryScreen />);
    fireEvent.click(screen.getByTestId('canvas'));
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    fixture.focused = true;
    screen.rerender(<StoryScreen />);
    flushPaints();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[stories] ready sample--loaded');
  });

  it('redirects tab stories before rendering content or readiness', () => {
    installStory('layout');
    fixture.story!.story.tab = 'home';
    const screen = render(<StoryScreen />);
    expect(screen.getByTestId('redirect')).toBeTruthy();
    expect(screen.queryByText('Content')).toBeNull();
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('does not render a requested story in a different eager tab', () => {
    installStory('layout');
    fixture.story!.story.tab = 'home';
    const screen = render(<StoryScreen inTab tab="record" />);
    expect(screen.queryByText('Content')).toBeNull();
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('does not report ready from mounting or layout while required assets are loading', () => {
    installStory('explicit');
    const screen = render(<StoryScreen />);
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('canvas'));
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    act(() => controls.onReady());
    flushPaints();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[stories] ready sample--loaded');
  });

  it('requires layout even when assets resolve first', () => {
    installStory('explicit');
    const screen = render(<StoryScreen />);
    act(() => controls.onReady());
    flushPaints();
    expect(console.log).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('canvas'));
    flushPaints();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('[stories] ready sample--loaded');
  });

  it('fails asset errors without later reporting a successful paint', () => {
    installStory('explicit');
    const screen = render(<StoryScreen />);
    fireEvent.click(screen.getByTestId('canvas'));
    act(() => {
      controls.onError(new Error('Missing board image'));
      controls.onReady();
    });
    flushPaints();
    expect(console.error).toHaveBeenCalledWith('[stories] error sample--loaded Missing board image');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('waits for fresh layout and assets when the same story is captured again', () => {
    installStory('explicit');
    const screen = render(<StoryScreen />);
    fireEvent.click(screen.getByTestId('canvas'));
    act(() => controls.onReady());
    flushPaints();
    fixture.shot = 'second';
    screen.rerender(<StoryScreen />);
    flushPaints();
    expect(console.log).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('canvas'));
    act(() => controls.onReady());
    flushPaints();
    expect(console.log).toHaveBeenCalledTimes(2);
  });

  it('reports renderer failures under the requested story id', () => {
    installStory('explicit');
    if (fixture.story && 'render' in fixture.story.story) {
      fixture.story.story.render = () => {
        throw new Error('Broken view');
      };
    }
    render(<StoryScreen />);
    flushPaints();
    expect(console.error).toHaveBeenCalledWith('[stories] error sample--loaded Broken view');
    expect(console.log).not.toHaveBeenCalled();
  });
});
