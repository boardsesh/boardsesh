import { createContext } from 'react';
export const NativeHeaderActionContext = createContext(false);

/** A standalone custom native item supplies its own glass after hiding UIKit's. */
export const NativeHeaderOwnBackgroundContext = createContext(false);

/** The widest the native title view may be, so a title can drop detail rather than clip. */
export const NativeTitleMaxWidthContext = createContext<number | undefined>(undefined);
