import { DeveloperGuidePage, guideMetadata } from '../guide-page';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => guideMetadata('auth');
export default function Page() {
  return DeveloperGuidePage({ slug: 'auth' });
}
