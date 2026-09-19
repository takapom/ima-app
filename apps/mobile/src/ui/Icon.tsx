import { View } from 'react-native';

const strokes = {
  menu: [
    [4, 7, 20, 7],
    [4, 12, 20, 12],
    [4, 17, 20, 17],
  ],
  plus: [
    [12, 5, 12, 19],
    [5, 12, 19, 12],
  ],
  arrow: [
    [12, 19, 12, 5],
    [5, 12, 12, 5],
    [12, 5, 19, 12],
  ],
  chevron: [
    [9, 5, 16, 12],
    [16, 12, 9, 19],
  ],
  bookmark: [
    [6, 4, 18, 4],
    [18, 4, 18, 20],
    [18, 20, 12, 16],
    [12, 16, 6, 20],
    [6, 20, 6, 4],
  ],
  close: [
    [6, 6, 18, 18],
    [18, 6, 6, 18],
  ],
  clock: [
    [12, 7, 12, 12],
    [12, 12, 15.5, 14],
  ],
} as const;

/** Decorative native strokes; the surrounding control owns the accessible name. */
export function Icon({
  name,
  color,
  size = 18,
}: {
  readonly name: keyof typeof strokes;
  readonly color: string;
  readonly size?: number;
}): React.JSX.Element {
  const scale = size / 24;
  const thickness = 2 * scale;
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      {name === 'clock' ? (
        <View
          style={{
            position: 'absolute',
            left: 3 * scale,
            top: 3 * scale,
            width: 18 * scale,
            height: 18 * scale,
            borderRadius: size,
            borderWidth: thickness,
            borderColor: color,
          }}
        />
      ) : null}
      {strokes[name].map(([x1, y1, x2, y2], index) => {
        const length = Math.hypot(x2 - x1, y2 - y1) * scale;
        return (
          <View
            key={index}
            style={{
              position: 'absolute',
              backgroundColor: color,
              height: thickness,
              width: length + thickness,
              borderRadius: thickness,
              left: ((x1 + x2) * scale) / 2 - (length + thickness) / 2,
              top: ((y1 + y2) * scale) / 2 - thickness / 2,
              transform: [{ rotate: `${(Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI}deg` }],
            }}
          />
        );
      })}
    </View>
  );
}
