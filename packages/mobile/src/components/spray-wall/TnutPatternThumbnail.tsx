import Svg, { Circle, Rect } from 'react-native-svg';
import type { TnutPattern } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';

const customPoints = [
  [23, 21],
  [43, 18],
  [66, 26],
  [82, 16],
  [18, 40],
  [40, 36],
  [76, 43],
  [58, 49],
  [27, 58],
  [46, 65],
  [81, 64],
  [17, 80],
  [35, 84],
  [63, 79],
  [83, 86],
];

/** The approved minimal diagram, drawn with the current light/dark theme. */
export function TnutPatternThumbnail({
  pattern,
  firstRowOffset = false,
}: {
  pattern: TnutPattern;
  firstRowOffset?: boolean;
}) {
  const { systemColors } = useTheme();
  const points =
    pattern === 'custom'
      ? customPoints
      : Array.from({ length: 5 }, (_, row) => {
          const inset = pattern === 'offset' && (row % 2 === 0) === firstRowOffset;
          return Array.from({ length: inset ? 4 : 5 }, (_, column) => [
            18 + column * 16 + (inset ? 8 : 0),
            18 + row * 16,
          ]);
        }).flat();
  return (
    <Svg width="100%" height="100%" viewBox="0 0 100 100" accessible={false}>
      <Rect width={100} height={100} rx={8} fill={systemColors.tertiaryGroupedBackground} />
      {points.map(([x, y], index) => (
        <Circle key={index} cx={x} cy={y} r={2.5} fill={systemColors.label} />
      ))}
    </Svg>
  );
}
