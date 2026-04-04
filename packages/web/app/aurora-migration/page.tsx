import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import AuroraMigrationContent from './aurora-migration-content';

export const metadata = createPageMetadata({
  title: 'Migrate from Old Kilter App',
  description: 'Migrate your Kilter board data to Boardsesh after the Aurora backend shutdown.',
  path: '/aurora-migration',
});

export default function AuroraMigrationPage() {
  return <AuroraMigrationContent />;
}
