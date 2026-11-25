// @vitest-environment jsdom
//
// "Which board?": MoonBoard, Kilter and Tension as big art tiles, every other
// type as a row under "Other boards", and all of them rows where three tiles
// don't fit (320 pt, large text). A tap moves on with the type.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';

type Children = { children?: ReactNode; testID?: string };
const windowSize = vi.hoisted(() => ({ width: 393, fontScale: 1 }));
const thumbnails = vi.hoisted(() => ({ drawn: [] as string[] }));

vi.mock('react-native', () => ({
  ScrollView: ({ children, testID }: Children) => createElement('div', { 'data-testid': testID }, children),
  View: ({ children, testID }: Children) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: windowSize.width, height: 852, fontScale: windowSize.fontScale }),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 5: 20 },
  cardCorners: { borderRadius: 16 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#222', label: '#fff' } }),
}));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: Children & { onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, children),
}));
vi.mock('../../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../../ArtRow', () => ({
  ArtRow: ({ title, onPress, testID, art }: { title: string; onPress: () => void; testID: string; art: ReactNode }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, [art, title]),
}));
vi.mock('../../../InsetGroupedList', () => ({
  InsetGroupedList: ({ children, testID }: Children) => createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('../../../ShelfHeader', () => ({
  ShelfHeader: ({ title }: { title: string }) => createElement('h2', null, title),
  SHELF_HEADER_CONTENT_GAP: 8,
  SHELF_SECTION_GAP: 28,
}));
vi.mock('../../../boards/BoardThumbnail', () => ({
  BoardThumbnail: ({ board }: { board: { boardType: string; layoutId: number } }) => {
    thumbnails.drawn.push(`${board.boardType}:${board.layoutId}`);
    return null;
  },
}));
vi.mock('../WizardStepHeader', () => ({
  WizardStepHeader: ({ title, stepLabel }: { title: string; stepLabel: string | null }) =>
    createElement('header', null, `${stepLabel ?? ''} ${title}`),
}));

const { BoardTypeStep } = await import('../BoardTypeStep');

beforeEach(() => {
  windowSize.width = 393;
  windowSize.fontScale = 1;
  thumbnails.drawn = [];
});

function tileTypes() {
  return [...document.querySelectorAll('[data-testid^="board-type-tile-"]')].map((tile) =>
    tile.getAttribute('data-testid')?.replace('board-type-tile-', ''),
  );
}
function rowTypes() {
  return [...document.querySelectorAll('[data-testid^="board-type-row-"]')].map((row) =>
    row.getAttribute('data-testid')?.replace('board-type-row-', ''),
  );
}

describe('BoardTypeStep', () => {
  it('draws the three big types as tiles and the rest as rows, every type once', () => {
    render(createElement(BoardTypeStep, { stepLabel: 'Step 2 of 3', popularConfigs: undefined, onPick: vi.fn() }));
    expect(tileTypes()).toEqual(['moonboard', 'kilter', 'tension']);
    expect(screen.getByText('mobile.addWizard.otherBoards')).toBeTruthy();
    expect(new Set([...tileTypes(), ...rowTypes()])).toEqual(new Set(SUPPORTED_BOARDS));
    expect(tileTypes().length + rowTypes().length).toBe(SUPPORTED_BOARDS.length);
    expect(screen.getByText('Step 2 of 3 mobile.addWizard.whichBoard')).toBeTruthy();
  });

  it("draws each type's real board art, never a placeholder image", () => {
    render(createElement(BoardTypeStep, { stepLabel: null, popularConfigs: undefined, onPick: vi.fn() }));
    const drawnTypes = new Set(thumbnails.drawn.map((drawn) => drawn.split(':')[0]));
    expect(drawnTypes).toEqual(new Set(SUPPORTED_BOARDS));
  });

  it.each([
    { name: 'a 320 pt phone', width: 320, fontScale: 1 },
    { name: 'large text', width: 402, fontScale: 1.5 },
  ])('lists every type as a row on $name, the big three first', ({ width, fontScale }) => {
    windowSize.width = width;
    windowSize.fontScale = fontScale;
    render(createElement(BoardTypeStep, { stepLabel: null, popularConfigs: undefined, onPick: vi.fn() }));
    expect(tileTypes()).toEqual([]);
    expect(rowTypes().slice(0, 3)).toEqual(['moonboard', 'kilter', 'tension']);
    expect(screen.queryByText('mobile.addWizard.otherBoards')).toBeNull();
  });

  it('moves on with the type tapped, from a tile or a row', () => {
    const onPick = vi.fn();
    render(createElement(BoardTypeStep, { stepLabel: null, popularConfigs: undefined, onPick }));
    fireEvent.click(screen.getByTestId('board-type-tile-kilter'));
    const [firstOther] = rowTypes();
    fireEvent.click(screen.getByTestId(`board-type-row-${firstOther}`));
    expect(onPick.mock.calls).toEqual([['kilter'], [firstOther]]);
  });
});
