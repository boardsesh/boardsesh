import MuiLink from '@mui/material/Link';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { BoardName } from '@/app/lib/types';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getBoardAppGuidePath } from '@/app/lib/i18n/published-locales';

/** Published in English only; the label makes the language change explicit. */
export default async function BoardAppGuideLink({ board }: { board: BoardName }) {
  const { t } = await getServerTranslation('website');
  return (
    <MuiLink
      component={LocaleLink}
      locale="en-US"
      href={getBoardAppGuidePath(board)}
      sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
    >
      {board === 'spray' ? t('sprayComparisonLink') : t('boardAppGuideLink', { board: boardTypeLabel(board) })}
    </MuiLink>
  );
}
