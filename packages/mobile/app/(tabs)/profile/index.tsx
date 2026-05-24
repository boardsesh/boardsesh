import { View, Text, Image, Pressable, ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useProfile } from '../../../src/lib/graphql/hooks';
import { useAuth } from '../../../src/providers/auth-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { SignInPrompt } from '../../../src/components/SignInPrompt';

export default function Profile() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslation('auth');

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <SignInPrompt
        title={t('nativeStart.prompt.profileTitle')}
        description={t('nativeStart.prompt.profileDescription')}
      />
    );
  }

  return <ProfileAuthenticated />;
}

function ProfileAuthenticated() {
  const { data: profile, isLoading } = useProfile();
  const { signOut } = useAuth();
  const { systemColors } = useTheme();
  const { t } = useTranslation('profile');

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.flex} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        {profile?.avatarUrl ? (
          <Image source={{ uri: profile.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: systemColors.fill }]}>
            <Text style={[styles.avatarInitial, { color: systemColors.secondaryLabel }]}>
              {profile?.displayName?.charAt(0)?.toUpperCase() ?? '?'}
            </Text>
          </View>
        )}
        <Text style={[styles.name, { color: systemColors.label }]}>
          {profile?.displayName ?? t('mobile.unknownName')}
        </Text>
        <Text style={[styles.email, { color: systemColors.secondaryLabel }]}>{profile?.email ?? ''}</Text>
      </View>

      <Pressable style={[styles.signOutButton, { borderColor: systemColors.separator }]} onPress={signOut}>
        <Text style={styles.signOutText}>{t('mobile.signOut')}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: 24,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 32,
    fontWeight: '600',
  },
  name: {
    marginTop: 16,
    fontSize: 22,
    fontWeight: '600',
  },
  email: {
    marginTop: 4,
    fontSize: 15,
  },
  signOutButton: {
    marginTop: 'auto',
    marginBottom: 32,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  signOutText: {
    fontSize: 17,
    color: '#FF3B30',
  },
});
