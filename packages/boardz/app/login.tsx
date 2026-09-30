import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { WEB_BASE_URL } from '../src/api/env';
import { useAuth } from '../src/auth/auth-provider';
import { Button } from '../src/ui/Button';
import { ExternalLink } from '../src/ui/icons';
import { Text } from '../src/ui/Text';
import { TextField } from '../src/ui/TextField';
import { Sheet } from '../src/ui/Sheet';
import { useTheme } from '../src/ui/theme';
import { spacing } from '../src/ui/tokens';

export default function LoginScreen() {
  const theme = useTheme();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result = await signIn(email, password);
    setSubmitting(false);
    if (result.ok) router.back();
    else setError(result.message);
  };

  return (
    <Sheet title="Sign in" avoidKeyboard>
      <Text variant="small" tone="tertiary">
        Use your Boardsesh email and password. Your logbook comes with you.
      </Text>
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="username"
        returnKeyType="next"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        autoComplete="current-password"
        secureTextEntry
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        error={error}
      />
      <Button
        title="Sign in"
        size="lg"
        fullWidth
        onPress={() => void submit()}
        disabled={!canSubmit}
        loading={submitting}
      />
      <View style={[styles.links, { borderTopColor: theme.border2 }]}>
        <Text variant="small" tone="tertiary">
          Signed up with Apple or Google? Boardz can only use a password, so set one on boardsesh.com first.
        </Text>
        <View style={styles.linkRow}>
          <Button
            title="Set a password"
            variant="ghost"
            size="sm"
            icon={ExternalLink}
            onPress={() => void Linking.openURL(`${WEB_BASE_URL}/auth/forgot-password`)}
          />
          <Button
            title="Create an account"
            variant="ghost"
            size="sm"
            icon={ExternalLink}
            accessibilityHint="Opens boardsesh.com, where Sign up is the second tab"
            onPress={() => void Linking.openURL(`${WEB_BASE_URL}/auth/login`)}
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  links: { gap: spacing.sm, paddingTop: spacing.lg, borderTopWidth: 1 },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginLeft: -spacing.md },
});
