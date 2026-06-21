import { forwardRef, useEffect, useState, type ComponentType } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile, UserSearchResult } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableAvatar } from '../PressableAvatar';
import { ListRow } from '../ListRow';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

export type SocialPerson = PublicUserProfile & {
  recentAscentCount?: number;
};

const SEARCH_DEBOUNCE_MS = 300;

export function useDebouncedClimberSearch(searchQuery: string) {
  const trimmedSearchQuery = searchQuery.trim();
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  useEffect(() => {
    if (trimmedSearchQuery.length < 2) {
      setDebouncedSearchQuery('');
      return;
    }

    const handle = setTimeout(() => setDebouncedSearchQuery(trimmedSearchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [trimmedSearchQuery]);

  const searchIsDebouncing = trimmedSearchQuery.length >= 2 && debouncedSearchQuery !== trimmedSearchQuery;
  const canUseSearchQuery = trimmedSearchQuery.length >= 2 && debouncedSearchQuery === trimmedSearchQuery;

  return { trimmedSearchQuery, debouncedSearchQuery, searchIsDebouncing, canUseSearchQuery };
}

export function mapSearchResults(results: UserSearchResult[]): SocialPerson[] {
  return results.map((result) => ({
    ...result.user,
    recentAscentCount: result.recentAscentCount,
  }));
}

export function personSubtitle(person: SocialPerson, t: (key: string, options?: Record<string, unknown>) => string) {
  if (person.recentAscentCount != null) {
    return t('mobile.social.recentAscents', { count: person.recentAscentCount });
  }

  return [
    t('mobile.social.followerCount', { count: person.followerCount }),
    t('mobile.social.followingCount', { count: person.followingCount }),
  ].join(' · ');
}

type SearchInputComponent = ComponentType<TextInputProps>;

type ClimberSearchFieldProps = {
  value: string;
  onChangeText: (value: string) => void;
  inputComponent?: SearchInputComponent;
  autoFocus?: boolean;
};

export const ClimberSearchField = forwardRef<TextInput, ClimberSearchFieldProps>(function ClimberSearchField(
  { value, onChangeText, inputComponent, autoFocus },
  ref,
) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  // Cast so `ref` + `autoFocus` type-check: the default TextInput and the
  // BottomSheetTextInput callers both forward a TextInput instance at runtime.
  const Input = (inputComponent ?? TextInput) as typeof TextInput;

  return (
    <View style={[styles.searchField, { backgroundColor: systemColors.fill }]}>
      <Icon name="search" size={18} color={systemColors.secondaryLabel} />
      <Input
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        placeholder={t('mobile.social.searchPlaceholder')}
        placeholderTextColor={iosSystemColors.systemGray}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={t('mobile.social.searchPlaceholder')}
        style={[styles.searchInput, { color: systemColors.label }]}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.social.clearSearch')}
          style={styles.clearButton}
        >
          <Icon name="close" size={16} color={systemColors.secondaryLabel} />
        </Pressable>
      ) : null}
    </View>
  );
});

type ClimberSearchPersonRowProps = {
  person: SocialPerson;
  currentUserId: string | undefined;
  isMutating: boolean;
  onToggleFollow: (person: PublicUserProfile) => void;
};

export function ClimberSearchPersonRow({
  person,
  currentUserId,
  isMutating,
  onToggleFollow,
}: ClimberSearchPersonRowProps) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const isCurrentUser = person.id === currentUserId;
  const displayName = person.displayName || t('mobile.unknownName');

  return (
    <ListRow
      title={displayName}
      subtitle={personSubtitle(person, t)}
      leading={<PressableAvatar userId={person.id} uri={person.avatarUrl} name={person.displayName} size={36} />}
      trailing={
        isCurrentUser ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.social.you')}
          </Text>
        ) : (
          <Button
            title={person.isFollowedByMe ? t('mobile.social.unfollowAction') : t('mobile.social.followAction')}
            accessibilityLabel={
              person.isFollowedByMe
                ? t('mobile.social.unfollowUser', { name: displayName })
                : t('mobile.social.followUser', { name: displayName })
            }
            size="small"
            variant={person.isFollowedByMe ? 'outlined' : 'filled'}
            loading={isMutating}
            disabled={isMutating}
            style={styles.followButton}
            onPress={() => onToggleFollow(person)}
          />
        )
      }
    />
  );
}

export function ClimberSearchLoadingState() {
  return (
    <View style={styles.stateBlock}>
      <ActivityIndicator size="large" />
    </View>
  );
}

export function ClimberSearchEmptyState({ query }: { query: string }) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const title = query.length < 2 ? t('mobile.social.searchHint') : t('mobile.social.emptySearch');

  return (
    <View style={styles.stateBlock}>
      <Icon name="search" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.stateTitle}>
        {title}
      </Text>
      {query.length >= 2 ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateSubtitle}>
          {t('mobile.social.emptySearchBody', { query })}
        </Text>
      ) : null}
    </View>
  );
}

export function ClimberSearchErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();

  return (
    <View style={styles.stateBlock}>
      <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.stateTitle}>
        {t('mobile.social.loadError')}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.social.retry')}
        style={({ pressed }) => [
          styles.retryButton,
          { borderColor: brandColors.primary },
          pressed && { backgroundColor: `${brandColors.primary}1A` },
        ]}
      >
        <Text variant="footnote" color={brandColors.primary}>
          {t('mobile.social.retry')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 42,
    borderRadius: 10,
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
  followButton: {
    minWidth: 84,
    minHeight: 44,
  },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[16],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    opacity: 0.65,
    textAlign: 'center',
  },
  stateSubtitle: {
    textAlign: 'center',
  },
  retryButton: {
    marginTop: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
