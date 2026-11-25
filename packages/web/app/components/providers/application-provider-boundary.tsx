'use client';

import dynamic from 'next/dynamic';
import type { ApplicationProviderStackProps } from './application-provider-stack';

const ApplicationProviderStack = dynamic(() => import('./application-provider-stack'));

/** Keep the former climbing site's providers out of marketing's initial route assets. */
export default function ApplicationProviderBoundary(props: ApplicationProviderStackProps) {
  return <ApplicationProviderStack {...props} />;
}
