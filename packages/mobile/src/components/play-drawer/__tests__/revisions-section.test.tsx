// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REVISIONS_PER_CLIMB } from '@boardsesh/board-config';
import climbsCatalog from '@boardsesh/i18n/locales/en-US/climbs.json';
import type { ClimbRevisionRow } from '@boardsesh/graphql/operations/climb-revisions';

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  calls: [] as Array<{ boardType: string; climbUuid: string }>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

/**
 * The REAL en-US catalog, interpolated the way i18next would, plurals included.
 * A `t` that echoed the key back could not tell "Edited 3 times" from a missing
 * string, or see whether the cap note carries its number.
 */
function translate(key: string, values: Record<string, unknown> = {}): string {
  const lookup = (path: string): unknown => {
    let node: unknown = climbsCatalog;
    for (const segment of path.split('.')) node = (node as Record<string, unknown> | undefined)?.[segment];
    return node;
  };
  const plural =
    typeof values.count === 'number' ? lookup(`${key}_${values.count === 1 ? 'one' : 'other'}`) : undefined;
  const template = plural ?? lookup(key);
  if (typeof template !== 'string') throw new Error(`no en-US climbs string at ${key}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name]));
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

vi.mock('../../CollapsibleSection', () => ({
  CollapsibleSection: (props: {
    title: string;
    summary?: string | null;
    defaultExpanded?: boolean;
    persistKey?: string;
    children?: ReactNode;
  }) =>
    createElement(
      'section',
      {
        'data-title': props.title,
        'data-summary': props.summary ?? '',
        'data-default-expanded': String(props.defaultExpanded ?? false),
        'data-persist-key': props.persistKey ?? '',
      },
      props.children,
    ),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666', tertiaryLabel: '#999', separator: '#ccc' },
    brandColors: { primary: '#7c3aed' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 }, borderRadius: { full: 999 } }));
vi.mock('../../../lib/graphql/hooks/use-climb-revisions', () => ({
  useClimbRevisions: (boardType: string, climbUuid: string) => {
    query.calls.push({ boardType, climbUuid });
    return { data: query.data };
  },
}));

import { RevisionsSection } from '../RevisionsSection';

/** `count` rows, newest first, the way the server returns them. */
function rows(count: number, overrides: Partial<ClimbRevisionRow> = {}): ClimbRevisionRow[] {
  return Array.from({ length: count }, (_unused, index) => {
    const revisionNumber = count - index;
    return {
      revisionNumber,
      isCurrent: index === 0,
      createdAt: `2026-0${Math.min(9, (revisionNumber % 9) + 1)}-15T10:00:00.000Z`,
      name: 'Left Arete',
      description: null,
      frames: 'p1r1',
      angle: 40,
      difficultyId: null,
      changes: revisionNumber === 1 ? [] : ['holds'],
      editor: { id: 'setter-1', displayName: 'Mara', avatarUrl: null },
      editedBySetter: true,
      sprayWallVersionNumber: null,
      ...overrides,
    };
  });
}

function renderSection(onOpenRevision?: (revisionNumber: number) => void) {
  return render(<RevisionsSection climbUuid="climb-1" boardName="spray" onOpenRevision={onOpenRevision} />);
}

beforeEach(() => {
  query.data = undefined;
  query.calls = [];
});

describe('RevisionsSection', () => {
  it.each([
    ['still loading, failed or offline', undefined],
    ['a climb nobody has edited', []],
    ['a single row', rows(1)],
  ])('renders nothing for %s', (_label, data) => {
    query.data = data;
    const { container } = renderSection(vi.fn());
    expect(container.innerHTML).toBe('');
  });

  it('shows the history from two rows up, collapsed, with a persisted key', () => {
    query.data = rows(2);
    const { container } = renderSection(vi.fn());

    const section = container.querySelector('section');
    expect(section?.getAttribute('data-title')).toBe('Edit history');
    expect(section?.getAttribute('data-summary')).toBe('Edited once');
    expect(section?.getAttribute('data-default-expanded')).toBe('false');
    expect(section?.getAttribute('data-persist-key')).toBe('revisions');
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(query.calls.at(-1)).toEqual({ boardType: 'spray', climbUuid: 'climb-1' });
  });

  it('counts edits, not rows, in the summary', () => {
    query.data = rows(4);
    const { container } = renderSection(vi.fn());
    expect(container.querySelector('section')?.getAttribute('data-summary')).toBe('Edited 3 times');
  });

  it('tags the top row Current, and says who edited and what changed', () => {
    const history = rows(3);
    history[0] = {
      ...history[0],
      changes: ['grade', 'name', 'something-newer'],
      editor: { id: 'owner-1', displayName: 'Jo', avatarUrl: null },
      editedBySetter: false,
    };
    query.data = history;
    renderSection(vi.fn());

    expect(screen.getAllByText('Current')).toHaveLength(1);
    expect(screen.getByText('Jo')).not.toBeNull();
    expect(screen.getAllByText('Wall editor')).toHaveLength(1);
    expect(screen.getAllByText('Setter')).toHaveLength(2);
    // Known kinds only, in a fixed order; the unknown one is dropped, not printed.
    expect(screen.getByText('Changed name, grade')).not.toBeNull();
    expect(screen.getByText('Changed holds')).not.toBeNull();
    expect(screen.getByText('First published')).not.toBeNull();
  });

  it('names a deleted account without giving it a role', () => {
    query.data = rows(2, { editor: null, editedBySetter: false });
    renderSection(vi.fn());
    expect(screen.getAllByText('Deleted account')).toHaveLength(2);
    expect(screen.queryByText('Wall editor')).toBeNull();
    expect(screen.queryByText('Setter')).toBeNull();
  });

  it('shows five rows, then the rest on "Show all"', () => {
    query.data = rows(8);
    const { container } = renderSection(vi.fn());
    // Five rows plus the "Show all" button.
    expect(container.querySelectorAll('button')).toHaveLength(6);

    fireEvent.click(screen.getByText('Show all 8'));

    expect(container.querySelectorAll('button')).toHaveLength(8);
    expect(screen.queryByText('Show all 8')).toBeNull();
  });

  it('offers no "Show all" at five rows or fewer', () => {
    query.data = rows(5);
    renderSection(vi.fn());
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it('never shows more than the cap, and says the cap with the number the server enforces', () => {
    query.data = rows(MAX_REVISIONS_PER_CLIMB + 7);
    const { container } = renderSection(vi.fn());

    fireEvent.click(screen.getByText(`Show all ${MAX_REVISIONS_PER_CLIMB}`));

    expect(container.querySelectorAll('button')).toHaveLength(MAX_REVISIONS_PER_CLIMB);
    const note = screen.getByText(/Only the first version/);
    expect(note.textContent).toContain(String(MAX_REVISIONS_PER_CLIMB));
    expect(note.textContent).not.toContain('{{');
    // The number comes from board-config, not from the catalog string.
    expect(climbsCatalog.mobile.revisions.capNote).toContain('{{max}}');
    expect(climbsCatalog.mobile.revisions.capNote).not.toMatch(/\d/);
  });

  it('says nothing about the cap on a short history', () => {
    query.data = rows(3);
    renderSection(vi.fn());
    expect(screen.queryByText(/Only the first version/)).toBeNull();
  });

  it('opens the tapped revision through the handler it was given', () => {
    query.data = rows(3);
    const onOpenRevision = vi.fn();
    const { container } = renderSection(onOpenRevision);

    fireEvent.click(container.querySelectorAll('button')[1]);

    expect(onOpenRevision).toHaveBeenCalledTimes(1);
    expect(onOpenRevision).toHaveBeenCalledWith(2);
  });

  it('is a plain list when no opener is wired', () => {
    query.data = rows(3);
    const { container } = renderSection();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getAllByText('Mara').length).toBe(3);
  });
});
