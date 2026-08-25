import type { MetadataRoute } from 'next';
import { resolveStaticAssetUrl } from './lib/static-asset-url';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Boardsesh',
    short_name: 'Boardsesh',
    description: 'Track your sends across Kilter, Tension, and MoonBoard. One app for your boards.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#15101e',
    theme_color: '#15101e',
    icons: [
      {
        src: resolveStaticAssetUrl('/icons/icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: resolveStaticAssetUrl('/icons/icon-512.png'),
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: resolveStaticAssetUrl('/icons/icon-maskable-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
