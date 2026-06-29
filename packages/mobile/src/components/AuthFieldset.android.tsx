// AuthFieldset — Android implementation.
//
// Android Autofill associates fields by the activity's autofill structure, not by
// view hierarchy, so the per-field `AuthTextInput` (each its own @expo/ui Host)
// already autofills correctly here — the iOS pairing problem this component fixes
// doesn't exist on Android. So we simply render the verified per-field
// `AuthTextInput` for each spec and wire the focus chain (return key advances to
// the next field; the last submits). No new native code.

import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../theme/tokens';
import { AuthTextInput } from './AuthTextInput';
import type { AuthTextInputHandle } from './AuthTextInput.types';
import type { AuthFieldsetProps } from './AuthFieldset.types';

export function AuthFieldset({ fields, onSubmit }: AuthFieldsetProps) {
  // Callback refs (not a ref per field) keep this off the rules-of-hooks
  // hooks-in-a-loop footgun while still letting field N advance focus to N+1.
  const refs = useRef<Array<AuthTextInputHandle | null>>([]);
  const lastIndex = fields.length - 1;

  return (
    <View style={styles.group}>
      {fields.map((field, index) => {
        const { key, ...fieldProps } = field;
        const isLast = index === lastIndex;
        return (
          <AuthTextInput
            key={key}
            {...fieldProps}
            ref={(handle) => {
              refs.current[index] = handle;
            }}
            returnKeyType={isLast ? 'done' : 'next'}
            onSubmitEditing={() => {
              if (isLast) onSubmit?.();
              else refs.current[index + 1]?.focus();
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matches the auth screens' previous inter-field gap (form: { gap: 12 }).
  group: { gap: spacing[3] },
});
