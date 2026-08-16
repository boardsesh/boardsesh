import type { Metadata } from 'next';
import { generateGymDirectoryMetadata, renderGymDirectory, type DirectoryRouteProps } from '../directory-page';

/** `/gyms/moonboard` — the same shell, filtered to gyms with a MoonBoard. */
export async function generateMetadata(): Promise<Metadata> {
  return generateGymDirectoryMetadata('moonboard');
}

export default async function MoonboardGymsDirectoryPage(props: DirectoryRouteProps) {
  return renderGymDirectory('moonboard', props);
}
