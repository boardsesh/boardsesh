import type { ComponentProps, ReactNode } from 'react';
import { MaterialTopAppBar } from './MaterialTopAppBar';
import { NativeRootHeader } from './NativeRootHeader';
import { CollapsingLargeTitleHeader } from './CollapsingLargeTitleHeader';

/** Shared screen chrome; account, board and hardware actions are injected by the controller. */
export function CollapsingTopChromeView({
  presentation,
  materialActions,
  ...header
}: ComponentProps<typeof NativeRootHeader> & {
  presentation: 'material' | 'native' | 'floating';
  centerTitle?: string;
  materialActions?: ReactNode;
}) {
  if (presentation === 'material')
    return (
      <MaterialTopAppBar onHeightChange={header.onHeightChange} scrollEdge={header.scrollEdge}>
        {materialActions}
      </MaterialTopAppBar>
    );
  if (presentation === 'native') return <NativeRootHeader {...header} />;
  return (
    <CollapsingLargeTitleHeader
      centerTitle={header.centerTitle}
      centerContent={header.centerContent}
      onHeightChange={header.onHeightChange}
      leftActions={header.leftActions}
      rightActions={header.rightActions}
    >
      {header.children}
    </CollapsingLargeTitleHeader>
  );
}
