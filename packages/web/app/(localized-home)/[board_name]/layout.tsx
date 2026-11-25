import type React from 'react';
import MarketingDocument from '@/app/components/marketing/marketing-document';
import { localizedHomeLocale } from '@/app/lib/i18n/localized-home';
import { getMarketingDocumentMetadata, marketingDocumentViewport } from '@/app/lib/seo/marketing-document-metadata';

type LayoutProps = { children: React.ReactNode; params: Promise<{ board_name: string }> };
export const viewport = marketingDocumentViewport;
export const dynamic = 'error';
export async function generateMetadata({ params }: LayoutProps) {
  return getMarketingDocumentMetadata(localizedHomeLocale((await params).board_name));
}
export default async function LocalizedHomeRootLayout({ children, params }: LayoutProps) {
  return <MarketingDocument locale={localizedHomeLocale((await params).board_name)}>{children}</MarketingDocument>;
}
