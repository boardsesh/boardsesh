import type { BoardName } from '@boardsesh/shared-schema';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { FirstBoardGymState } from '../../lib/boards/first-board-gym-state';
import { canOpenAppSettings } from '../../lib/open-app-settings';
import { useTheme } from '../../providers/theme-provider';
import { EmptyState } from '../EmptyState';
import { TextAction, textActionOverhang } from '../TextAction';
import { nearbyEmptyLine } from './nearby-board-type-copy';

type NearbyQuietStatusProps = {
  state: FirstBoardGymState;
  /** The search found boards, and every one of them is already shown elsewhere in the picker. */
  allShownAbove: boolean;
  onRetryNearby: () => void;
  onOpenSettings: () => void;
  /** The gym map. Only offered here while the header's action is Show all, not Map. */
  onFindGymOnMap: () => void;
  boardType?: BoardName | null;
};

/**
 * The ordinary picker's Near you when it has no cards to show: one quiet
 * footnote line under the header, which already carries Map (or Show all when
 * narrowed to one type), with the one action that can change the answer. Near
 * you shows only once location is allowed, so it never asks for it: the
 * picker's "See gyms near you" card does (`LocationAskCard`). First run keeps
 * `NearbySearchStatus`'s fuller panel.
 *
 * Its action sits between two others: Map 8pt above (and right above, once Map
 * wraps under the title at a large text size), Your boards' Manage across the
 * 28pt gap below. Neither gap holds a full target, so the action leans down,
 * away from Map, and keeps the room it leans into: the line's block takes its
 * target's overhang below, and Manage, leaning up, stops short of it.
 */
export function NearbyQuietStatus({
  state,
  allShownAbove,
  onRetryNearby,
  onOpenSettings,
  onFindGymOnMap,
  boardType = null,
}: NearbyQuietStatusProps) {
  const { t } = useTranslation('boards');
  const { variant } = useTheme();
  if (allShownAbove) {
    return <EmptyState size="quiet" title={t('mobile.discovery.nearbyAllAbove')} />;
  }
  let line: string;
  let action: ReactElement | null = null;
  switch (state) {
    // Not asked yet: the picker shows the location banner instead of Near you.
    // Searching: placeholder cards hold the space (NearbyReservedSlot).
    // Found: the cards themselves.
    case 'idle':
    case 'searching':
    case 'found':
      return null;
    case 'none_nearby':
      line = nearbyEmptyLine(t, boardType);
      // Narrowed, the header's action is Show all, so the map is offered here.
      if (boardType) {
        action = <TextAction reach="down" label={t('mobile.discovery.nearbyMap')} onPress={onFindGymOnMap} />;
      }
      break;
    case 'nearby_error':
      line = t('mobile.firstBoard.nearbyError');
      action = <TextAction reach="down" label={t('mobile.errorRetry')} onPress={onRetryNearby} />;
      break;
    case 'location_off':
      line = t('mobile.firstBoard.locationOff');
      if (canOpenAppSettings()) {
        action = <TextAction reach="down" label={t('mobile.firstBoard.openSettings')} onPress={onOpenSettings} />;
      }
      break;
  }
  const roomBelow = action ? { paddingBottom: textActionOverhang(variant, 'down').bottom } : undefined;
  return (
    <View accessibilityLiveRegion="polite" style={roomBelow}>
      <EmptyState size="quiet" title={line} actions={action ?? undefined} />
    </View>
  );
}
