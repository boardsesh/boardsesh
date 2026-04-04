import { createPageMetadata } from '@/app/lib/seo/metadata';
import DocsClientPage from './docs-client';

export const metadata = createPageMetadata({
  title: 'API Documentation',
  description: 'REST and WebSocket API documentation for Boardsesh - interactive climbing training board integration',
  path: '/docs',
});

export default function DocsPage() {
  return <DocsClientPage />;
}
