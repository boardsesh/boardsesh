import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { guideDocument, type GuideSlug } from './guide-documents';

/** Machine clients get English canonical docs without cookies or client rendering. */
export async function guideMarkdownResponse(slug: GuideSlug): Promise<Response> {
  const state = getDeveloperDocsState();
  if (state === 'unavailable')
    return new Response(null, {
      status: 404,
      headers: { 'X-Robots-Tag': 'noindex, follow', 'Cache-Control': 'no-store' },
    });
  const { t } = await getServerTranslationForLocale('en-US', 'developers');
  return new Response(guideDocument(slug, t), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, follow',
      Link: `<https://www.boardsesh.com/developers/${slug}>; rel="canonical"`,
    },
  });
}
