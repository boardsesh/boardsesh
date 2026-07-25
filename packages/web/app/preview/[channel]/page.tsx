import { notFound } from 'next/navigation';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { previewPullRequestNumber } from '@/app/lib/ota-preview-link';
import PreviewChannelContent from './preview-channel-content';

// Landing page for the "Open this preview in Boardsesh" link that every PR's
// OTA-preview comment carries. GitHub's markdown sanitiser only renders
// http/https anchors, so the comment can't link a com.boardsesh.app:// URL
// directly — it links here instead.
//
// On iOS this URL never renders: the wildcard AASA (app/.well-known/
// apple-app-site-association) already claims /preview/*, so the tap opens the
// app straight onto the channel. Android (until the /preview intent filter ships
// in a native build) and desktop land here, and get the scheme link + a QR.
//
// Utility surface, so it's noindex and stays out of sitemap.ts.

type Props = {
  params: Promise<{ channel: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { channel } = await params;
  const { t, locale } = await getServerTranslation('common');
  const pullNumber = previewPullRequestNumber(channel);
  if (pullNumber === null) return {};

  return createNoIndexMetadata({
    title: t('otaPreview.metadata.title', { number: pullNumber }),
    description: t('otaPreview.metadata.description', { number: pullNumber }),
    path: `/preview/${channel}`,
    locale,
  });
}

export default async function OtaPreviewPage({ params }: Props) {
  const { channel } = await params;
  const pullNumber = previewPullRequestNumber(channel);
  // Only the pr-<number> channels the preview workflow publishes are real pages.
  if (pullNumber === null) notFound();

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common']}>
      <PreviewChannelContent channel={channel} pullNumber={pullNumber} />
    </I18nProvider>
  );
}
