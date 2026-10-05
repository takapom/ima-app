import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';
import { colors } from '@mobile/ui/theme/tokens';

const VIEW_BOX = { x: 20, y: -6, width: 350, height: 222 } as const;
const EYE_WHITE = '#fbfaf6';

/** The "ima" wordmark with the pin from docs/icon/ima-icon-pin.svg. */
export function ImaWordmark({ width }: { readonly width: number }): React.JSX.Element {
  return (
    <Svg
      accessibilityLabel="ima"
      accessibilityRole="image"
      width={width}
      height={(width * VIEW_BOX.height) / VIEW_BOX.width}
      viewBox={`${VIEW_BOX.x} ${VIEW_BOX.y} ${VIEW_BOX.width} ${VIEW_BOX.height}`}
    >
      <G
        fill="none"
        stroke={colors.text}
        strokeWidth={26}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Path d="M40 110V200" />
        <Path d="M90 200V140A30 30 0 0 1 150 140V200M150 140A30 30 0 0 1 210 140V200" />
        <Circle cx={305} cy={155} r={45} />
        <Path d="M350 110V200" />
      </G>
      <Circle cx={40} cy={68} r={15} fill={colors.text} />
      <Path
        d="M195 88C184 74 159 58 159 34A36 36 0 0 1 231 34C231 58 206 74 195 88Z"
        fill={colors.lime}
      />
      <Ellipse cx={181} cy={32} rx={11} ry={13} fill={EYE_WHITE} />
      <Ellipse cx={209} cy={32} rx={11} ry={13} fill={EYE_WHITE} />
      <Circle cx={182} cy={38} r={6.5} fill={colors.ink} />
      <Circle cx={208} cy={38} r={6.5} fill={colors.ink} />
      <Circle cx={179.5} cy={35.5} r={2} fill={EYE_WHITE} />
      <Circle cx={205.5} cy={35.5} r={2} fill={EYE_WHITE} />
    </Svg>
  );
}
