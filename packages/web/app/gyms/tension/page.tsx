import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from '../directory-page';

/** `/gyms/tension` — the same shell, filtered to gyms with a Tension board. */
export async function generateMetadata(): Promise<Metadata> {
  return generateGymDirectoryMetadata('tension');
}

export default async function TensionGymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('tension', props);
}
