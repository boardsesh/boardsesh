import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { FONT } from './fonts';
import { Icon, type IconComponent } from './Icon';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius } from './tokens';

export type SegmentOption<T extends string | number> = {
  value: T;
  label: string;
  /** Widens this cell when the strip is full width. */
  grow?: number;
  icon?: IconComponent;
  iconRight?: IconComponent;
  accessibilityLabel?: string;
};

const HEIGHTS = { sm: 32, md: 40, lg: 44, xl: 56 } as const;

type CommonProps<T extends string | number> = {
  options: readonly SegmentOption<T>[];
  size?: keyof typeof HEIGHTS;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
};

type SingleProps<T extends string | number> = CommonProps<T> & {
  multiple?: false;
  value: T;
  onChange: (value: T) => void;
};

type MultipleProps<T extends string | number> = CommonProps<T> & {
  multiple: true;
  value: readonly T[];
  onChange: (value: T[]) => void;
};

/**
 * The control strip: a hairline box split into cells, the selected cell in
 * ink. Single choice, or `multiple` for filter toggles.
 */
export function SegmentedControl<T extends string | number>(props: SingleProps<T> | MultipleProps<T>) {
  const theme = useTheme();
  const { options, size = 'md', fullWidth = false, style } = props;
  const height = HEIGHTS[size];
  const isOn = (value: T) => (props.multiple ? props.value.includes(value) : props.value === value);
  const pick = (value: T) => {
    void Haptics.selectionAsync();
    if (props.multiple) {
      props.onChange(isOn(value) ? props.value.filter((item) => item !== value) : [...props.value, value]);
    } else {
      props.onChange(value);
    }
  };

  return (
    <View
      accessibilityRole={props.multiple ? undefined : 'radiogroup'}
      style={[
        styles.strip,
        { height, borderColor: theme.border2, alignSelf: fullWidth ? 'stretch' : 'flex-start' },
        style,
      ]}
    >
      {options.map((option, index) => {
        const on = isOn(option.value);
        const foreground = on ? theme.fgOnAccent : theme.fg2;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={props.multiple ? 'button' : 'radio'}
            accessibilityState={props.multiple ? { selected: on } : { checked: on }}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            onPress={() => pick(option.value)}
            style={[
              styles.cell,
              {
                flex: fullWidth ? (option.grow ?? 1) : undefined,
                backgroundColor: on ? theme.accent : 'transparent',
                borderLeftWidth: index > 0 ? 1 : 0,
                borderLeftColor: theme.border2,
              },
            ]}
          >
            {option.icon ? <Icon icon={option.icon} size={16} color={foreground} /> : null}
            <Text
              variant="body"
              color={foreground}
              numberOfLines={1}
              style={{
                fontFamily: FONT.sansMedium,
                fontSize: size === 'sm' ? 13 : size === 'xl' ? 15 : 14,
                lineHeight: 18,
              }}
            >
              {option.label}
            </Text>
            {option.iconRight ? <Icon icon={option.iconRight} size={13} color={foreground} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  cell: {
    minWidth: 0,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
});
