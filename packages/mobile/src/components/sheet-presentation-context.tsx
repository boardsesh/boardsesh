import { createContext, useContext, type ReactNode } from 'react';
import type { SheetPresentationMode } from '../lib/sheet-presentation-policy';

export type SheetPresentationCapabilities = {
  mode: SheetPresentationMode;
  supportsDetents: boolean;
  setAccessibleTitle?: (title: string) => void;
};
export const SheetPresentationContext = createContext<SheetPresentationCapabilities>({
  mode: 'native',
  supportsDetents: true,
});
export function useSheetPresentation(): SheetPresentationCapabilities {
  return useContext(SheetPresentationContext);
}

/** Lets header, body and footer use the host's capabilities without input checks. */
export function SheetPresentationContent({
  children,
}: {
  children: (presentation: SheetPresentationCapabilities) => ReactNode;
}) {
  return children(useSheetPresentation());
}
