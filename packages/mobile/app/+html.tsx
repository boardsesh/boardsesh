import { ScrollViewStyleReset } from 'expo-router/html';
import type { ReactNode } from 'react';

export default function RootHtml({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="robots" content="noindex, follow" />
        <meta name="application-name" content="Boardsesh" />
        <meta name="theme-color" content="#000000" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="https://www.boardsesh.com/icons/icon-192.png" />
        <link rel="apple-touch-icon" href="https://www.boardsesh.com/icons/apple-touch-icon.png" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
