import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../providers/auth-provider';
import { hapticLight } from '../lib/haptics';
import { brandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function SignInButton({ title, onPress }: { title: string; onPress: () => void }) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      accessibilityRole="button"
      onPress={() => {
        hapticLight();
        onPress();
      }}
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 20, stiffness: 300, mass: 0.7 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 20, stiffness: 300, mass: 0.7 });
      }}
      style={[animatedStyle, styles.button]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </AnimatedPressable>
  );
}

type SignInPromptProps = {
  title: string;
  description?: string;
};

export function SignInPrompt({ title, description }: SignInPromptProps) {
  const { signIn } = useAuth();
  const { t } = useTranslation('auth');

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>

      <View style={styles.buttons}>
        {Platform.OS === 'ios' && <SignInButton title={t('nativeStart.signInApple')} onPress={() => signIn('apple')} />}
        <SignInButton title={t('nativeStart.signInGoogle')} onPress={() => signIn('google')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center', color: brandColors.primary, marginBottom: 12 },
  description: { fontSize: 15, lineHeight: 22, textAlign: 'center', opacity: 0.7 },
  buttons: { gap: 12 },
  button: {
    backgroundColor: brandColors.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: iosSystemColors.white,
    fontSize: 17,
    fontWeight: '600',
  },
});
