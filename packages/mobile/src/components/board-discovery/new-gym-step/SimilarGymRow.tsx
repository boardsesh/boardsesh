import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SimilarGym } from '@boardsesh/shared-schema';
import { ArtRow } from '../../ArtRow';
import { Button } from '../../Button';
import { Icon } from '../../Icon';
import { useTheme } from '../../../providers/theme-provider';
import { InsetGroupedCell } from '../../gym-page/InsetGroupedCell';
import type { GroupedCellPosition } from '../../gym-page/gym-page-view-model';

/** The art at the head of the row: the gym glyph on a quiet 36pt circle, as on Which gym?'s rows. */
function SimilarGymGlyph() {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.glyphCircle, { backgroundColor: systemColors.tertiaryFill }]}>
      <Icon name="gym" size={18} color={systemColors.secondaryLabel} />
    </View>
  );
}

const GYM_GLYPH = <SimilarGymGlyph />;

/**
 * A listed gym that looks like the one being added, drawn like a row on Which
 * gym? (`PickGymRow`): its name, then "350 m · street". A tap says "it's this
 * one" and goes to its boards. Claim shows only where the climber may claim it,
 * and opens its page, where the claim lives.
 */
export const SimilarGymRow = memo(function SimilarGymRow({
  gym,
  subtitle,
  position,
  onPickGym,
  onClaimGym,
}: {
  gym: SimilarGym;
  subtitle: string | null;
  position: GroupedCellPosition;
  onPickGym: (gymUuid: string) => void;
  onClaimGym: (gymUuid: string) => void;
}) {
  const { t } = useTranslation('boards');
  const handlePress = useCallback(() => onPickGym(gym.uuid), [onPickGym, gym.uuid]);
  const handleClaim = useCallback(() => onClaimGym(gym.uuid), [onClaimGym, gym.uuid]);
  const accessory = useMemo(
    () =>
      gym.isClaimable ? (
        <Button
          title={t('mobile.newGym.claim')}
          accessibilityLabel={t('mobile.newGym.claimAria', { gym: gym.name })}
          onPress={handleClaim}
          variant="text"
          size="small"
          minHeight={44}
        />
      ) : (
        'chevron'
      ),
    [gym.isClaimable, gym.name, handleClaim, t],
  );
  return (
    <InsetGroupedCell position={position} separatorInset="compact">
      <ArtRow
        art={GYM_GLYPH}
        artSize="compact"
        title={gym.name}
        titleVariant="body"
        subtitle={subtitle ?? undefined}
        accessory={accessory}
        onPress={handlePress}
        testID={`new-gym-similar-${gym.uuid}`}
      />
    </InsetGroupedCell>
  );
});

const styles = StyleSheet.create({
  glyphCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
