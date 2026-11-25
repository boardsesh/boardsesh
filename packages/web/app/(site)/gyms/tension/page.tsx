import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from '@/app/gyms/directory-page';

/** `/gyms/tension` — the same shell, filtered to gyms with a Tension board. */
export async function generateMetadata(props: DirectoryRouteProps): Promise<Metadata> {
  return generateGymDirectoryMetadata('tension', await props.searchParams);
}

export default async function TensionGymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('tension', props);
}
