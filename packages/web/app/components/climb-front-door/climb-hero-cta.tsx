import React from 'react';
import { climbQrUrl } from '@/app/lib/gym-attribution';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { climbBoardForSearch } from '@/app/lib/seo/climb-display';
import type { HandoffTree } from './climb-handoff-cta';
import FrontDoorHeroCta from './front-door-hero-cta';

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

/**
 * The climb page's call to action: `FrontDoorHeroCta` with the climb's words.
 *
 * Below md the store badge is the primary action: a phone with Boardsesh opens
 * climb links straight in the app, so a phone reading this page almost never
 * has it. From md the hand-off is the filled button, and a QR
 * code beside it carries the climb to a phone. `FrontDoorHeroCta` holds the
 * layout and why it is CSS only.
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
    <FrontDoorHeroCta
      placement="climb-view"
      qrCardPlacement="climb-qr-card"
      qrLanding="climb"
      handoff={{
        pathname: handoffPath,
        surface: 'climb_front_door',
        tree,
        boardName,
        layoutId,
        angle,
        climbUuid,
        locale,
      }}
      qrUrl={climbQrUrl(handoffPath, locale)}
      storeLabels={storeLabels}
      labels={{
        storeHelper: t('frontDoor.cta.getAppHelper', { board: climbBoardForSearch(boardName, layoutName) }),
        handoffMobile: t('frontDoor.cta.openInBrowserMobile'),
        handoffDesktop: t('frontDoor.cta.openInBrowser'),
        qr: {
          title: t('frontDoor.qr.title'),
          body: t('frontDoor.qr.body'),
          imageLabel: t('frontDoor.qr.imageLabel', { climbName }),
        },
      }}
    />
  );
}
