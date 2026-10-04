import { View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import Bookmark from 'lucide-react-native/icons/bookmark';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Clock from 'lucide-react-native/icons/clock';
import JapaneseYen from 'lucide-react-native/icons/japanese-yen';
import MapPin from 'lucide-react-native/icons/map-pin';
import Menu from 'lucide-react-native/icons/menu';
import Plus from 'lucide-react-native/icons/plus';
import TrainFront from 'lucide-react-native/icons/train-front';
import X from 'lucide-react-native/icons/x';

const icons = {
  menu: Menu,
  plus: Plus,
  arrow: ArrowUp,
  chevron: ChevronRight,
  bookmark: Bookmark,
  close: X,
  clock: Clock,
  mapPin: MapPin,
  train: TrainFront,
  yen: JapaneseYen,
} satisfies Record<string, LucideIcon>;

/** Decorative Lucide glyphs; the surrounding control owns the accessible name. */
export function Icon({
  name,
  color,
  size = 18,
}: {
  readonly name: keyof typeof icons;
  readonly color: string;
  readonly size?: number;
}): React.JSX.Element {
  const LucideGlyph = icons[name];
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      <LucideGlyph color={color} size={size} strokeWidth={2} />
    </View>
  );
}
