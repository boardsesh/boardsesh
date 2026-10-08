import { View, StyleSheet, type ViewProps } from 'react-native';

/** HIG readable content guide: prose and forms stay within 672pt on wide windows. */
export const READABLE_CONTENT_WIDTH = 672;
export const readableColumnStyle = StyleSheet.create({
  column: { width: '100%', maxWidth: READABLE_CONTENT_WIDTH, alignSelf: 'center' },
}).column;

export function ReadableColumn({ style, ...props }: ViewProps) {
  return <View {...props} style={[readableColumnStyle, style]} />;
}
