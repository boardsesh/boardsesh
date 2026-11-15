// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetBoardseshSupportForTests, setBoardseshRendererSupport } from '../../../hooks/boardsesh-renderer-support';
vi.mock('../../../hooks/use-native-climb-render', () => ({ ensureBoardseshSupportProbed: vi.fn() }));
import {
  StoryRenderModeContext,
  parseStoryRenderMode,
  useStoryBoardRenderStyle,
  useStoryRendererReady,
  type StoryRenderMode,
} from '../board-render-style';
const wrapperFor =
  (mode: StoryRenderMode) =>
  ({ children }: { children: ReactNode }) =>
    createElement(StoryRenderModeContext.Provider, { value: mode }, children);
beforeEach(() => _resetBoardseshSupportForTests());
describe('story renderer selection', () => {
  it.each(['classic', 'aura', 'default'] as const)('injects the requested %s settings', (mode) => {
    const { result } = renderHook(useStoryBoardRenderStyle, { wrapper: wrapperFor(mode) });
    expect(result.current.settings.mode).toBe(mode);
  });
  it('allows classic without an Aura probe', () => {
    const { result } = renderHook(useStoryRendererReady, { wrapper: wrapperFor('classic') });
    expect(result.current).toBe(true);
  });
  it.each(['aura', 'default'] as const)('withholds readiness until %s is supported', (mode) => {
    const { result } = renderHook(useStoryRendererReady, { wrapper: wrapperFor(mode) });
    expect(result.current).toBe(false);
    act(() => setBoardseshRendererSupport(true));
    expect(result.current).toBe(true);
  });
  it('fails instead of acknowledging a classic fallback', () => {
    setBoardseshRendererSupport(false);
    expect(() => renderHook(useStoryRendererReady, { wrapper: wrapperFor('aura') })).toThrow(
      'Aura renderer is unavailable',
    );
  });
  it('rejects an unknown deep-link renderer', () =>
    expect(() => parseStoryRenderMode('unknown')).toThrow('Unsupported story renderer'));
});
