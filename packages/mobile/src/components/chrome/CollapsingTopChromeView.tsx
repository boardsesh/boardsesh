import { selectByVariant } from '../../theme/variants';
import type { ComponentProps, ReactNode } from 'react';
import { MaterialTopAppBar } from './MaterialTopAppBar';
import { NativeRootHeader } from './NativeRootHeader';
import { CollapsingLargeTitleHeader } from './CollapsingLargeTitleHeader';

const uiVariantByPresentation = { material: 'material', native: 'liquidGlass', floating: 'liquidGlass' } as const;

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
  return selectByVariant(uiVariantByPresentation[presentation], {
    material: (
      <MaterialTopAppBar onHeightChange={header.onHeightChange} scrollEdge={header.scrollEdge}>
        {materialActions}
      </MaterialTopAppBar>
    ),
    liquidGlass:
      presentation === 'native' ? (
        <NativeRootHeader {...header} />
      ) : (
        <CollapsingLargeTitleHeader
          centerTitle={header.centerTitle}
          centerContent={header.centerContent}
          onHeightChange={header.onHeightChange}
          leftActions={header.leftActions}
          rightActions={header.rightActions}
        >
          {header.children}
        </CollapsingLargeTitleHeader>
      ),
  });
}
