import { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { Searchbar } from 'react-native-paper';
import { Icon } from './Icon';
import { GlassSurface } from './GlassSurface';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { iosSystemColors } from '../theme/ios-colors';

export type SearchHeaderHandle = {
  blur: () => void;
  focus: () => void;
  getText: () => string;
  /**
   * Set the field text imperatively. Pass `{ silent: true }` for programmatic
   * seeding (board restore / per-board sync / recent-pill apply) to update only
   * the displayed value WITHOUT re-entering `onChangeText` — which would re-arm
   * the caller's input debounce and redundantly re-commit the term (and could
   * outlive a fast board switch).
   */
  setText: (text: string, options?: { silent?: boolean }) => void;
};

type SearchHeaderProps = {
  placeholder: string;
  onChangeText: (text: string) => void;
  onSubmit?: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Seeds the field on mount — reflects a restored per-board search. */
  initialValue?: string;
  /** Capsule height (defaults to 44). The top chrome passes its FAB height so the
   *  expanded field matches them. The radius tracks height/2 for a pill. */
  height?: number;
};

/**
 * The climb-name search field, styled as a Liquid Glass capsule for the
 * climb-list search row. The glass fills a clipped pill behind the magnifier +
 * input; it degrades to a solid `systemColors.fill` capsule on Android / Reduce
 * Transparency / cold-start via GlassSurface. Keeps an imperative handle so the
 * screen can blur it and seed restored text without a remount.
 */
export const SearchHeader = forwardRef<SearchHeaderHandle, SearchHeaderProps>(function SearchHeader(
  { placeholder, onChangeText, onSubmit, onFocus, onBlur, initialValue = '', height = 44 },
  ref,
) {
  const inputRef = useRef<TextInput>(null);
  const { systemColors, variant: uiVariant } = useTheme();
  const [text, setText] = useState(initialValue);
  const radius = height / 2;

  useImperativeHandle(ref, () => ({
    blur: () => inputRef.current?.blur(),
    focus: () => inputRef.current?.focus(),
    getText: () => text,
    setText: (newText: string, options?: { silent?: boolean }) => {
      setText(newText);
      if (!options?.silent) onChangeText(newText);
    },
  }));

  const handleChange = useCallback(
    (newText: string) => {
      setText(newText);
      onChangeText(newText);
    },
    [onChangeText],
  );

  const handleClear = useCallback(() => {
    setText('');
    onChangeText('');
    inputRef.current?.focus();
  }, [onChangeText]);

  const handleSubmit = useCallback(() => {
    onSubmit?.(text);
    inputRef.current?.blur();
  }, [onSubmit, text]);

  // Material variant: an authentic MD3 search bar. The imperative handle still
  // works because Paper's Searchbar forwards its ref to the inner TextInput
  // (blur/focus) and getText/setText stay backed by our own `text` state.
  const isMaterial = selectByVariant(uiVariant, { material: true, liquidGlass: false });
  if (isMaterial) {
    return (
      <View style={[styles.materialFrame, { height, borderRadius: radius }]}>
        <Searchbar
          ref={inputRef}
          value={text}
          onChangeText={handleChange}
          onClearIconPress={handleClear}
          mode="bar"
          placeholder={placeholder}
          onFocus={onFocus}
          onBlur={onBlur}
          onSubmitEditing={handleSubmit}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={placeholder}
          elevation={0}
          iconColor={systemColors.secondaryLabel as string}
          rippleColor={systemColors.fill}
          inputStyle={styles.materialInput}
          // Pin the full footprint on first mount. Paper's Searchbar contains a
          // Surface + TextInput stack; on Android it can draw only the tonal
          // surface for one frame if its parent hands it an unconstrained flex
          // slot. The wrapper owns the slot, and the Searchbar fills it.
          style={[
            styles.materialSearchbar,
            { height, borderRadius: radius, backgroundColor: systemColors.tertiaryBackground as string },
          ]}
        />
      </View>
    );
  }

  return (
    <View style={[styles.capsule, { height, borderRadius: radius }]}>
      <GlassSurface
        glassEffectStyle="regular"
        fallbackColor={systemColors.fill}
        borderRadius={radius}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[styles.content, { height }]}>
        <Icon name="search" size={18} color={iosSystemColors.systemGray} />
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={handleChange}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          placeholderTextColor={iosSystemColors.systemGray}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={handleSubmit}
          clearButtonMode="never"
          style={[styles.input, { color: systemColors.label }]}
          accessibilityLabel={placeholder}
        />
        {text.length > 0 && (
          <Pressable onPress={handleClear} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
            <View style={styles.clearButton}>
              <Icon name="close" size={12} color={iosSystemColors.white} />
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  // Material (Paper Searchbar): fill the row slot's width; minHeight is applied
  // inline from the `height` prop so the first layout pass can't collapse to 0.
  materialFrame: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  materialSearchbar: {
    flex: 1,
    width: '100%',
    margin: 0,
  },
  materialInput: {
    minHeight: 0,
    paddingVertical: 0,
    textAlignVertical: 'center',
    fontSize: 16,
  },
  capsule: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    paddingHorizontal: 14,
    gap: 6,
  },
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
  },
  clearButton: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: iosSystemColors.systemGray,
    opacity: 0.6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
