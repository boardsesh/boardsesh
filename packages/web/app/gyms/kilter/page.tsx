import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from '../directory-page';

/** `/gyms/kilter` — the same shell, filtered to gyms with a Kilter board. */
export async function generateMetadata(): Promise<Metadata> {
  return generateGymDirectoryMetadata('kilter');
}

export default async function KilterGymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('kilter', props);
}
