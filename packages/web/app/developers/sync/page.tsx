import { DeveloperGuidePage, guideMetadata } from '../guide-page';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => guideMetadata('sync');
export default function Page() {
  return DeveloperGuidePage({ slug: 'sync' });
}
