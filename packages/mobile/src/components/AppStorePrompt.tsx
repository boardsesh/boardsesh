// Native build of the store prompt: nothing. Someone running the app from a
// store binary does not need a link to the store.
//
// The real component is `AppStorePrompt.web.tsx`, which Metro picks for the
// browser app (BOARDSESH_WEB=1). Keeping the native half an empty component
// means the screens that mount it need no `Platform.OS` branch, and none of the
// web-only code (the user-agent read, the store-link builder) reaches a native
// bundle.

import type { AppStorePromptProps } from './AppStorePrompt.types';

export function AppStorePrompt(_props: AppStorePromptProps): null {
  return null;
}
