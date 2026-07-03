import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GymMemberRole } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import {
  useGymMembers,
  useGrantGymWriteAccess,
  useRevokeGymWriteAccess,
  useSearchUsers,
} from '../../lib/graphql/hooks';
import { useDebouncedClimberSearch, mapSearchResults, type SocialPerson } from '../you/ClimberSearch';

// The grant search shows only the top matches — a bounded slice rendered inline in
// the edit screen's ScrollView (never a nested virtualized list). Gyms have a
// handful of staff, so the member roster is bounded too.
const MAX_SEARCH_RESULTS = 8;

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function roleLabel(role: GymMemberRole, t: TranslateFn): string {
  switch (role) {
    case 'admin':
      return t('mobile.gymGrant.roles.admin');
    case 'editor':
      return t('mobile.gymGrant.roles.editor');
    case 'member':
      return t('mobile.gymGrant.roles.member');
  }
}

/**
 * The write-access manager on the gym-edit screen, shown only when the viewer
 * `canGrantAccess`. Lists the gym's current members with their role, lets an
 * admin search climbers by name and grant `editor` access, and gives each editor
 * a revoke action. Rendered inline inside the edit form's scroll, so it uses the
 * screen's toast (the surface is a pushed route, not a modal sheet).
 */
export function GymWriteAccessSection({ gymUuid }: { gymUuid: string }) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();

  const membersQuery = useGymMembers(gymUuid);
  const grant = useGrantGymWriteAccess();
  const revoke = useRevokeGymWriteAccess();

  const [searchQuery, setSearchQuery] = useState('');
  const { canUseSearchQuery, debouncedSearchQuery } = useDebouncedClimberSearch(searchQuery);
  const searchResults = useSearchUsers(debouncedSearchQuery, canUseSearchQuery);

  const members = membersQuery.data?.members;
  const mutationPending = grant.isPending || revoke.isPending;

  // Top matches that aren't already on the roster (granting to an existing member
  // would just be a role change, which the roster's own revoke handles).
  const candidates = useMemo<SocialPerson[]>(() => {
    const firstPage = searchResults.data?.pages[0]?.results ?? [];
    const memberIds = new Set((members ?? []).map((member) => member.userId));
    return mapSearchResults(firstPage)
      .filter((person) => !memberIds.has(person.id))
      .slice(0, MAX_SEARCH_RESULTS);
  }, [searchResults.data, members]);

  const handleGrant = useCallback(
    async (userId: string) => {
      try {
        await grant.mutateAsync({ gymUuid, userId });
        showToast(t('mobile.gymGrant.granted'), 'success');
        setSearchQuery('');
      } catch {
        showToast(t('mobile.gymGrant.grantFailed'), 'error');
      }
    },
    [grant, gymUuid, showToast, t],
  );

  const handleRevoke = useCallback(
    async (userId: string) => {
      try {
        await revoke.mutateAsync({ gymUuid, userId });
        showToast(t('mobile.gymGrant.revoked'), 'success');
      } catch {
        showToast(t('mobile.gymGrant.revokeFailed'), 'error');
      }
    },
    [revoke, gymUuid, showToast, t],
  );

  const isSearching = canUseSearchQuery && (searchResults.isLoading || searchResults.isFetching);

  return (
    <View style={styles.section}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
        {t('mobile.gymGrant.sectionTitle')}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.description}>
        {t('mobile.gymGrant.description')}
      </Text>

      <View style={[styles.searchField, { backgroundColor: systemColors.fill }]}>
        <Icon name="search" size={18} color={systemColors.secondaryLabel} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('mobile.gymGrant.searchPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('mobile.gymGrant.searchLabel')}
          style={[styles.searchInput, { color: systemColors.label }]}
        />
        {searchQuery.length > 0 ? (
          <PressableSurface
            onPress={() => setSearchQuery('')}
            feedback="opacity"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.gymGrant.clearSearch')}
            style={styles.clearButton}
          >
            <Icon name="close" size={16} color={systemColors.secondaryLabel} />
          </PressableSurface>
        ) : null}
      </View>

      {canUseSearchQuery ? (
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          {isSearching && candidates.length === 0 ? (
            <View style={styles.searchState}>
              <ActivityIndicator />
            </View>
          ) : candidates.length === 0 ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyResults}>
              {t('mobile.gymGrant.noResults')}
            </Text>
          ) : (
            candidates.map((person, index) => (
              <View
                key={person.id}
                style={[
                  styles.personRow,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator },
                ]}
              >
                <Avatar uri={person.avatarUrl} name={person.displayName} size={36} />
                <View style={styles.personText}>
                  <Text variant="body" numberOfLines={1}>
                    {person.displayName || t('mobile.gymGrant.unknownUser')}
                  </Text>
                </View>
                <Button
                  title={t('mobile.gymGrant.grant')}
                  size="small"
                  variant="filled"
                  disabled={mutationPending}
                  loading={grant.isPending}
                  onPress={() => void handleGrant(person.id)}
                  accessibilityLabel={t('mobile.gymGrant.grantFor', {
                    name: person.displayName || t('mobile.gymGrant.unknownUser'),
                  })}
                  style={styles.actionButton}
                />
              </View>
            ))
          )}
        </View>
      ) : null}

      <Text variant="footnote" color={systemColors.secondaryLabel} style={[styles.sectionLabel, styles.rosterLabel]}>
        {t('mobile.gymGrant.membersTitle')}
      </Text>
      {membersQuery.isLoading ? (
        <View style={styles.searchState}>
          <ActivityIndicator />
        </View>
      ) : members && members.length > 0 ? (
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          {members.map((member, index) => (
            <View
              key={member.userId}
              style={[
                styles.personRow,
                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator },
              ]}
            >
              <Avatar uri={member.avatarUrl} name={member.displayName} size={36} />
              <View style={styles.personText}>
                <Text variant="body" numberOfLines={1}>
                  {member.displayName || t('mobile.gymGrant.unknownUser')}
                </Text>
                <Text variant="footnote" color={systemColors.secondaryLabel}>
                  {roleLabel(member.role, t)}
                </Text>
              </View>
              {member.role === 'editor' ? (
                <Button
                  title={t('mobile.gymGrant.revoke')}
                  size="small"
                  variant="outlined"
                  role="destructive"
                  tintColor={brandColors.error}
                  disabled={mutationPending}
                  loading={revoke.isPending}
                  onPress={() => void handleRevoke(member.userId)}
                  accessibilityLabel={t('mobile.gymGrant.revokeFor', {
                    name: member.displayName || t('mobile.gymGrant.unknownUser'),
                  })}
                  style={styles.actionButton}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyResults}>
          {t('mobile.gymGrant.membersEmpty')}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing[6],
  },
  sectionLabel: {
    marginBottom: spacing[1],
    textTransform: 'uppercase',
  },
  rosterLabel: {
    marginTop: spacing[5],
  },
  description: {
    marginBottom: spacing[3],
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 42,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
  },
  searchInput: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
  },
  clearButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -spacing[3],
  },
  card: {
    marginTop: spacing[2],
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  personText: {
    flex: 1,
  },
  actionButton: {
    minHeight: 44,
  },
  searchState: {
    paddingVertical: spacing[4],
    alignItems: 'center',
  },
  emptyResults: {
    marginTop: spacing[2],
    paddingHorizontal: spacing[1],
  },
});
