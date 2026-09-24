import { SavedPlacePreviewPanel } from '@mobile/saved-places/components/SavedPlacePreviewPanel';
import type { SavedPlacePreviewUi } from '@mobile/saved-places/hooks/useSavedPlacePreview';

type SavedPlacePreviewSurfaceProps = {
  readonly controller: SavedPlacePreviewUi;
  readonly onSourcePress?: (sourceLink: string) => void;
};

export function SavedPlacePreviewSurface({
  controller,
  onSourcePress,
}: SavedPlacePreviewSurfaceProps): React.JSX.Element | null {
  if (!controller.connected) return null;
  return (
    <SavedPlacePreviewPanel
      onClose={controller.close}
      onRetry={controller.retry}
      {...(onSourcePress === undefined ? {} : { onSourcePress })}
      state={controller.preview}
    />
  );
}
