import { DeveloperGuidePage, guideMetadata } from '../guide-page';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => guideMetadata('changelog');
export default function Page() {
  return DeveloperGuidePage({ slug: 'changelog' });
}
