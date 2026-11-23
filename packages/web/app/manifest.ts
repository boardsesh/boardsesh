import type { MetadataRoute } from 'next';
import { resolveShellStaticAssetUrl } from './lib/shell-static-asset-url';
import { themeTokens } from './theme/theme-config';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Boardsesh',
    short_name: 'Boardsesh',
    description: 'Track your sends across Kilter, Tension, and MoonBoard. One app for your boards.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    // The page ground, so the install splash and the browser chrome match the page
    // (and the root layout's themeColor) instead of a frozen marketing violet.
    background_color: themeTokens.semantic.background,
    theme_color: themeTokens.semantic.background,
    icons: [
      {
        src: resolveShellStaticAssetUrl('/icons/icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: resolveShellStaticAssetUrl('/icons/icon-512.png'),
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: resolveShellStaticAssetUrl('/icons/icon-maskable-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
