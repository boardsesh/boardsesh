import { View, StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';

type SeparatorProps = {
  inset?: number;
};

export function Separator({ inset = 0 }: SeparatorProps) {
  const { systemColors } = useTheme();
  return <View style={[styles.separator, { marginLeft: inset, backgroundColor: systemColors.separator }]} />;
}

const styles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
