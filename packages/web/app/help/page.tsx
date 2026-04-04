import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import HelpContent from './help-content';

export const metadata = createPageMetadata({
  title: 'Help',
  description:
    'Learn about Boardsesh features including heatmaps, party mode, playlist generator, and more.',
  path: '/help',
});

export default function HelpPage() {
  return <HelpContent />;
}
