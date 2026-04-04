import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import AboutContent from './about-content';

export const metadata = createPageMetadata({
  title: 'About',
  description:
    'One app for every climbing board. Open source, community-driven.',
  path: '/about',
});

export default function AboutPage() {
  return <AboutContent />;
}
