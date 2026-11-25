import React from 'react';
import { notFound } from 'next/navigation';
import AppGuidePage from '@/app/components/app-guides/app-guide-page';
import { getAppGuideMetadata, loadAppGuideCopy } from '@/app/components/app-guides/app-guide-copy';
import { APP_GUIDE_SLUGS, getAppGuide } from '@/app/lib/seo/app-guides';

type RouteProps = { params: Promise<{ slug: string }> };
export const dynamicParams = false;

async function getGuideForRoute({ params }: RouteProps) {
  const guide = getAppGuide((await params).slug);
  if (!guide) notFound();
  return guide;
}

export function generateStaticParams() {
  return APP_GUIDE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata(props: RouteProps) {
  return getAppGuideMetadata(await getGuideForRoute(props));
}

export default async function BoardAppGuidePage(props: RouteProps) {
  const guide = await getGuideForRoute(props);
  const copy = await loadAppGuideCopy();
  return <AppGuidePage guide={guide} {...copy} />;
}
