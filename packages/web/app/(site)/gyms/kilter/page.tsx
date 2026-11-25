import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from '@/app/gyms/directory-page';

/** `/gyms/kilter` — the same shell, filtered to gyms with a Kilter board. */
export async function generateMetadata(props: DirectoryRouteProps): Promise<Metadata> {
  return generateGymDirectoryMetadata('kilter', await props.searchParams);
}

export default async function KilterGymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('kilter', props);
}
