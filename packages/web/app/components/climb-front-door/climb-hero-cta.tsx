import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { climbQrUrl } from '@/app/lib/gym-attribution';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { climbBoardForSearch } from '@/app/lib/seo/climb-display';
import { themeTokens } from '@/app/theme/theme-config';
import { ClimbHandoffLink, type HandoffTree } from './climb-handoff-cta';
import MobileStorePrimary from './mobile-store-primary';
import PhoneQrCard from './phone-qr-card';
import { STICKY_INSTALL_HIDE_ATTRIBUTE } from './sticky-install-markers';

type ClimbHeroCtaProps = {
  climbName: string;
  climbUuid: string;
  boardName: string;
  layoutId: number;
  layoutName?: string | null;
  angle: number;
  /** The pathname the reader is on, as `ClimbFrontDoor` documents it. The hand-off and the QR both carry it. */
  handoffPath: string;
  tree: HandoffTree;
};

/** MUI's `md`, where the page turns into two columns. */
const DESKTOP_MEDIA = '@media (min-width: 900px)';

const blockSx = {
  display: 'grid',
  justifyItems: { xs: 'stretch', md: 'start' },
  gap: { xs: `${themeTokens.spacing[2]}px`, md: `${themeTokens.spacing[4]}px` },
};

const mobileInstallSx = {
  display: { xs: 'grid', md: 'none' },
  gap: `${themeTokens.spacing[3]}px`,
};

const helperSx = {
  margin: 0,
  color: 'var(--neutral-700)',
  fontSize: themeTokens.typography.fontSize.base,
  textAlign: 'center',
};

/**
 * One anchor, two looks. Below md it is the quiet way out under the store
 * button: a centred text link. From md it is the filled button, the page's one
 * primary action on a laptop, where the browser app works.
 */
const handoffSx = {
  justifySelf: { xs: 'center', md: 'start' },
  minHeight: 44,
  paddingInline: `${themeTokens.spacing[3]}px`,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontSize: themeTokens.typography.fontSize.base,
  color: 'var(--color-primary)',
  [DESKTOP_MEDIA]: brandCtaSx({ size: 'large', glow: true }),
};

const mobileOnlySx = { display: { xs: 'inline', md: 'none' } };
const desktopOnlySx = { display: { xs: 'none', md: 'inline' } };
const desktopIconSx = { display: { xs: 'none', md: 'inline-flex' }, marginRight: `${themeTokens.spacing[2]}px` };
const desktopBlockSx = { display: { xs: 'none', md: 'block' }, width: '100%' };

/**
 * The climb page's call to action, split by screen width with CSS alone.
 *
 * A phone reading this page almost never has the app: a phone with it opens
 * climb links straight in the app. So below md the one filled button is the
 * store ("Get the free app"), with a line saying what the app does here, and
 * the hand-off to the browser app drops to a text link. From md the hand-off is
 * the filled button, and a QR code beside it carries the climb to a phone.
 *
 * One DOM for every reader: the page is stored at the edge and handed to
 * everyone, so nothing here may depend on who asked. The split is `display`
 * only, which also means nothing moves once the page has painted.
 *
 * `data-cta` names the two blocks for the page's tests: the store button is the
 * only filled button below md, inside `mobile-install`, and the hand-off is
 * `handoff`. `data-sticky-install-hide` tells the sticky install bar this block
 * is on screen.
 */
export default async function ClimbHeroCta({
  climbName,
  climbUuid,
  boardName,
  layoutId,
  layoutName,
  angle,
  handoffPath,
  tree,
}: ClimbHeroCtaProps) {
  const [{ t, locale }, storeLabels] = await Promise.all([getServerTranslation('climbs'), getStoreButtonLabels()]);

  return (
    <Box sx={blockSx}>
      <Box sx={mobileInstallSx} data-cta="mobile-install" {...{ [STICKY_INSTALL_HIDE_ATTRIBUTE]: '' }}>
        <MobileStorePrimary
          placement="climb-view"
          qrLanding="climb"
          labels={{
            install: t('frontDoor.cta.getApp'),
            update: storeLabels.update,
            installAria: {
              ios: t('frontDoor.cta.getAppAriaIos'),
              android: t('frontDoor.cta.getAppAriaAndroid'),
            },
          }}
        />
        <Typography component="p" sx={helperSx}>
          {t('frontDoor.cta.getAppHelper', { board: climbBoardForSearch(boardName, layoutName) })}
        </Typography>
      </Box>

      <ClimbHandoffLink
        pathname={handoffPath}
        ariaLabel={t('frontDoor.cta.openInBrowserAria', { climbName })}
        surface="climb_front_door"
        tree={tree}
        boardName={boardName}
        layoutId={layoutId}
        angle={angle}
        climbUuid={climbUuid}
        locale={locale}
        ctaName="handoff"
        sx={handoffSx}
      >
        <Box component="span" sx={desktopIconSx}>
          <OpenInBrowserIcon aria-hidden />
        </Box>
        <Box component="span" sx={mobileOnlySx}>
          {t('frontDoor.cta.openInBrowserMobile')}
        </Box>
        <Box component="span" sx={desktopOnlySx}>
          {t('frontDoor.cta.openInBrowser')}
        </Box>
      </ClimbHandoffLink>

      <Box sx={desktopBlockSx}>
        <PhoneQrCard
          url={climbQrUrl(handoffPath, locale)}
          title={t('frontDoor.qr.title')}
          body={t('frontDoor.qr.body')}
          imageLabel={t('frontDoor.qr.imageLabel', { climbName })}
          placement="climb-view"
          storeLabels={storeLabels}
          qrLanding="climb"
        />
      </Box>
    </Box>
  );
}
