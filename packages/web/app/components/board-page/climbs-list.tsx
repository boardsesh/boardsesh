'use client';
/**
 * Backward-compatible wrapper for consumers that use ClimbsList directly
 * (e.g. session-detail-content, multiboard-climb-list).
 *
 * The main browse routes now use ClimbsListShell + ListViewContent / GridViewContent
 * directly via board-page-list-view.tsx and board-page-grid-view.tsx.
 */
import React from 'react';
import ClimbsListShell, { type ClimbsListShellProps, type ViewContentRenderProps } from './climbs-list-shared';
import ListViewContent from './list-view-content';

export type { SharedDrawerHandle } from './climbs-list-shared';

export type ClimbsListProps = Omit<ClimbsListShellProps, 'viewMode' | 'children'>;

const ClimbsList = (props: ClimbsListProps) => (
  <ClimbsListShell viewMode="list" {...props}>
    {(contentProps: ViewContentRenderProps) => <ListViewContent {...contentProps} />}
  </ClimbsListShell>
);

export default ClimbsList;
