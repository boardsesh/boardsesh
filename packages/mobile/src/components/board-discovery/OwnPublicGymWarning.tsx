import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { useGym, useProfile } from '../../lib/graphql/hooks';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { useTheme } from '../../providers/theme-provider';

/**
 * A board in a public gym is shown at the gym's location to anyone its own
 * location is hidden from. When that gym is the climber's own (often a home
 * wall that minted a public gym under the old rules), its listing is their
 * home address. Say so, and point at the gym's settings where it can be made
 * private. A synced or someone else's gym never shows this: the climber cannot
 * change it, and its location is not theirs.
 */
export function OwnPublicGymWarning({ gymUuid }: { gymUuid: string | null | undefined }) {
  const { t } = useTranslation('boards');
  const { spacing } = useTheme();
  const { data: profile } = useProfile();
  const { data: gym } = useGym(gymUuid ?? null);
  if (!gym || !profile?.id || !gym.isPublic || gym.ownerId !== profile.id) return null;
  return (
    <View style={{ gap: spacing[2] }} accessibilityRole="alert">
      <Text>{t('mobile.publicGymWarning.message', { name: gym.name })}</Text>
      <Button
        title={t('mobile.publicGymWarning.openSettings')}
        variant="outlined"
        onPress={() => router.push({ pathname: '/gyms/edit', params: { gymUuid: gym.uuid } })}
      />
    </View>
  );
}
