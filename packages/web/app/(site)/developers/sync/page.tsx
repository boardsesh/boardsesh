import { DeveloperGuidePage, guideMetadata } from '@/app/developers/guide-page';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => guideMetadata('sync');
export default function Page() {
  return DeveloperGuidePage({ slug: 'sync' });
}
