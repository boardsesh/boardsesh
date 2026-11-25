import { DeveloperGuidePage, guideMetadata } from '@/app/developers/guide-page';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => guideMetadata('reference');
export default function Page() {
  return DeveloperGuidePage({ slug: 'reference' });
}
