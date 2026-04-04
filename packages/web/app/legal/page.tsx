import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import LegalContent from './legal-content';

export const metadata = createPageMetadata({
  title: 'Legal & Intellectual Property Policy',
  description:
    'Legal and intellectual property policy for Boardsesh, including our position on climb data, interoperability, and trademark usage.',
  path: '/legal',
});

export default function LegalPage() {
  return <LegalContent />;
}
