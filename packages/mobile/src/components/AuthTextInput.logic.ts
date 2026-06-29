// Pure, node-testable helpers shared by both platform AuthTextInput files. No
// rendering, no @expo/ui imports (the platform-import guard forbids
// swift-ui/jetpack-compose outside the matching platform file — even type-only —
// so the native modifier arg unions are re-declared here as plain string
// literals; each is a subset of the real @expo/ui union, so the platform file
// feeds the result straight into the native modifier and tsc checks the fit).

import type { TextInputProps } from 'react-native';

// --- Controlled-value bridge ------------------------------------------------

/**
 * Whether an incoming controlled `value` should be pushed into the native
 * observable. The native field owns its text and mirrors edits back through
 * `onTextChange`, so we only push when `value` changed to something we did NOT
 * just emit — i.e. an external reset/seed (e.g. EditProfile seeding the email
 * once the profile resolves). This guards against caret-jump/feedback loops and
 * avoids reading the observable on the JS thread (where reads are async/stale).
 */
export function shouldPushValueToNative(incomingValue: string, lastEmittedValue: string): boolean {
  return incomingValue !== lastEmittedValue;
}

/** Android reveal-toggle: a secure field is masked unless the user revealed it. */
export function computeMasked(secureTextEntry: boolean, revealed: boolean): boolean {
  return secureTextEntry && !revealed;
}

// --- iOS (SwiftUI) prop → modifier mappers ----------------------------------

type IosKeyboardType =
  | 'default'
  | 'email-address'
  | 'numeric'
  | 'phone-pad'
  | 'decimal-pad'
  | 'url'
  | 'numbers-and-punctuation'
  | 'ascii-capable';
type IosAutocapitalization = 'never' | 'words' | 'sentences' | 'characters';
type IosTextContentType = 'emailAddress' | 'password' | 'newPassword' | 'username' | 'name' | 'oneTimeCode';
type IosSubmitLabel = 'done' | 'go' | 'next' | 'return' | 'search' | 'send';

/** RN `keyboardType` → SwiftUI `keyboardType` modifier arg (undefined = default). */
export function toIosKeyboardType(keyboardType: TextInputProps['keyboardType']): IosKeyboardType | undefined {
  switch (keyboardType) {
    case 'email-address':
      return 'email-address';
    case 'numeric':
    case 'number-pad':
      return 'numeric';
    case 'phone-pad':
      return 'phone-pad';
    case 'decimal-pad':
      return 'decimal-pad';
    case 'url':
      return 'url';
    case 'default':
      return 'default';
    default:
      return undefined;
  }
}

/** RN `autoCapitalize` → SwiftUI `textInputAutocapitalization` modifier arg. */
export function toIosAutocapitalization(
  autoCapitalize: TextInputProps['autoCapitalize'],
): IosAutocapitalization | undefined {
  switch (autoCapitalize) {
    case 'none':
      return 'never';
    case 'words':
      return 'words';
    case 'sentences':
      return 'sentences';
    case 'characters':
      return 'characters';
    default:
      return undefined;
  }
}

/** RN `textContentType` → SwiftUI `textContentType` modifier arg (autofill). */
export function toIosTextContentType(
  textContentType: TextInputProps['textContentType'],
): IosTextContentType | undefined {
  switch (textContentType) {
    case 'emailAddress':
      return 'emailAddress';
    case 'password':
      return 'password';
    case 'newPassword':
      return 'newPassword';
    case 'username':
      return 'username';
    case 'name':
      return 'name';
    case 'oneTimeCode':
      return 'oneTimeCode';
    default:
      return undefined;
  }
}

/** RN `returnKeyType` → SwiftUI `submitLabel` modifier arg (the return-key label). */
export function toIosSubmitLabel(returnKeyType: TextInputProps['returnKeyType']): IosSubmitLabel | undefined {
  switch (returnKeyType) {
    case 'done':
      return 'done';
    case 'next':
      return 'next';
    case 'go':
      return 'go';
    case 'search':
      return 'search';
    case 'send':
      return 'send';
    default:
      return undefined;
  }
}

// --- Android (Compose) prop → keyboard-options mapper -----------------------

type AndroidCapitalization = 'none' | 'characters' | 'words' | 'sentences';
type AndroidKeyboardType = 'text' | 'number' | 'email' | 'phone' | 'decimal' | 'password' | 'uri';
type AndroidImeAction = 'default' | 'go' | 'search' | 'send' | 'next' | 'done';

export type AndroidKeyboardOptions = {
  capitalization?: AndroidCapitalization;
  autoCorrectEnabled?: boolean;
  keyboardType?: AndroidKeyboardType;
  imeAction?: AndroidImeAction;
};

function toAndroidCapitalization(autoCapitalize: TextInputProps['autoCapitalize']): AndroidCapitalization {
  switch (autoCapitalize) {
    case 'characters':
      return 'characters';
    case 'words':
      return 'words';
    case 'sentences':
      return 'sentences';
    // Default to 'none' (not RN's implicit 'sentences') — every auth call site
    // passes an explicit autoCapitalize, and 'none' is the safe default for the
    // email/password fields.
    default:
      return 'none';
  }
}

function toAndroidKeyboardType(keyboardType: TextInputProps['keyboardType']): AndroidKeyboardType | undefined {
  switch (keyboardType) {
    case 'email-address':
      return 'email';
    case 'numeric':
    case 'number-pad':
      return 'number';
    case 'phone-pad':
      return 'phone';
    case 'decimal-pad':
      return 'decimal';
    case 'url':
      return 'uri';
    default:
      return undefined;
  }
}

function toAndroidImeAction(returnKeyType: TextInputProps['returnKeyType']): AndroidImeAction {
  switch (returnKeyType) {
    case 'next':
      return 'next';
    case 'done':
      return 'done';
    case 'go':
      return 'go';
    case 'search':
      return 'search';
    case 'send':
      return 'send';
    default:
      return 'default';
  }
}

/**
 * Build the Compose `OutlinedTextField` keyboard options from the RN-ish props.
 * A secure field with no explicit `keyboardType` gets the `password` IME (which
 * disables learning/suggestions) and forces autocorrect off — matching RN's
 * `secureTextEntry` behaviour.
 */
export function toAndroidKeyboardOptions(input: {
  keyboardType: TextInputProps['keyboardType'];
  autoCapitalize: TextInputProps['autoCapitalize'];
  autoCorrect: boolean | undefined;
  returnKeyType: TextInputProps['returnKeyType'];
  secureTextEntry: boolean;
}): AndroidKeyboardOptions {
  const explicitKeyboardType = toAndroidKeyboardType(input.keyboardType);
  const keyboardType = explicitKeyboardType ?? (input.secureTextEntry ? 'password' : undefined);
  return {
    capitalization: toAndroidCapitalization(input.autoCapitalize),
    autoCorrectEnabled: input.secureTextEntry ? false : input.autoCorrect,
    keyboardType,
    imeAction: toAndroidImeAction(input.returnKeyType),
  };
}

/**
 * RN `autoComplete` → Compose `semantics({ contentType })` value. RN's
 * `autoComplete` tokens (`email`, `password`, `new-password`, `name`, …) are
 * exactly the HTML-autocomplete strings @expo/ui's Kotlin `toContentType()`
 * maps, and unknown strings map to `null` there (no crash) — so this is a safe
 * pass-through; the field omits the modifier when undefined.
 */
export function toAndroidContentType(autoComplete: TextInputProps['autoComplete']): string | undefined {
  // Intentional pass-through (not a transform): RN's autoComplete tokens already
  // match the strings @expo/ui's Kotlin toContentType() maps. Kept as a named,
  // tested seam so the call site reads clearly and the mapping has one home.
  return autoComplete;
}
