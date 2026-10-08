import { createContext } from 'react';
export const NativeHeaderActionContext = createContext(false);

/** A standalone custom native item supplies its own glass after hiding UIKit's. */
export const NativeHeaderOwnBackgroundContext = createContext(false);
