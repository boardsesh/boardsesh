/**
 * Keep browser-owned chrome and the exposed document shell aligned with the
 * app's resolved appearance. The static HTML starts dark before React mounts;
 * this takes over after preference hydration so a saved Light/System choice
 * also updates form controls, scrollbars, and any background around the app.
 */
export function syncDocumentAppearance(colorScheme: 'light' | 'dark', backgroundColor: string): void {
  if (typeof document === 'undefined') return;

  document.documentElement.style.colorScheme = colorScheme;
  document.documentElement.style.backgroundColor = backgroundColor;

  if (document.body) {
    document.body.style.backgroundColor = backgroundColor;
  }

  const appRoot = document.getElementById('root');
  if (appRoot) {
    appRoot.style.backgroundColor = backgroundColor;
  }
}
