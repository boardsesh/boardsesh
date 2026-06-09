// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const deferred = vi.hoisted(() => ({
  ready: false,
  calls: [] as Array<{ active: boolean; resetKey: string | number | undefined }>,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../hooks/use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: (active: boolean, resetKey?: string | number) => {
    deferred.calls.push({ active, resetKey });
    return deferred.ready;
  },
}));

vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    children,
    onHeaderLayout,
  }: {
    title: string;
    children?: ReactNode;
    onHeaderLayout?: (height: number) => void;
  }) => {
    onHeaderLayout?.(44);
    return createElement('section', { 'data-title': title }, children);
  },
}));

vi.mock('../BetaVideosSection', () => ({
  BetaVideosSection: () => createElement('div', { 'data-testid': 'beta-videos' }),
}));

vi.mock('../LogbookSection', () => ({
  LogbookSection: () => createElement('div', { 'data-testid': 'logbook' }),
}));

vi.mock('../CommunitySection', () => ({
  CommunitySection: () => createElement('div', { 'data-testid': 'community' }),
}));

vi.mock('../SimilarClimbsSection', () => ({
  SimilarClimbsSection: () => createElement('div', { 'data-testid': 'similar-climbs' }),
}));

import { DeferredSections } from '../DeferredSections';

const climb = {
  uuid: 'climb-1',
  userAscents: 0,
  userAttempts: 0,
  quality_average: '3',
  ascensionist_count: 0,
} as Climb;

function renderSections(options: { enabled?: boolean; contentEnabled?: boolean } = {}) {
  return render(
    <DeferredSections
      climb={climb}
      boardName="kilter"
      layoutId={1}
      sizeId={10}
      setIds="1,2"
      angle={40}
      enabled={options.enabled ?? true}
      contentEnabled={options.contentEnabled ?? false}
      onSimilarClimbPress={vi.fn()}
    />,
  );
}

describe('DeferredSections', () => {
  beforeEach(() => {
    deferred.ready = false;
    deferred.calls = [];
  });

  it('keeps Beta videos eager while heavier sections wait for scroll and interaction readiness', () => {
    renderSections({ contentEnabled: false });

    expect(screen.getByTestId('beta-videos')).not.toBeNull();
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(screen.queryByTestId('community')).toBeNull();
    expect(screen.queryByTestId('similar-climbs')).toBeNull();
    expect(deferred.calls.at(-1)).toEqual({ active: false, resetKey: 'climb-1' });
  });

  it('still waits for the interaction defer after the content is requested', () => {
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('beta-videos')).not.toBeNull();
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(deferred.calls.at(-1)).toEqual({ active: true, resetKey: 'climb-1' });
  });

  it('renders the heavier sections once both gates are open', () => {
    deferred.ready = true;
    renderSections({ contentEnabled: true });

    expect(screen.getByTestId('beta-videos')).not.toBeNull();
    expect(screen.getByTestId('logbook')).not.toBeNull();
    expect(screen.getByTestId('community')).not.toBeNull();
    expect(screen.getByTestId('similar-climbs')).not.toBeNull();
  });

  it('renders nothing while disabled', () => {
    const { container } = renderSections({ enabled: false, contentEnabled: true });

    expect(container.childElementCount).toBe(0);
  });
});
