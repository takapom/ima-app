import { SavedPlaceConsultationBanner } from './SavedPlaceConsultationBanner';
import { SavedPlacePreviewPanel } from './SavedPlacePreviewPanel';
import type { SavedPlacePreviewUi } from '../../hooks/useSavedPlacePreview';

type SavedPlacePreviewSurfaceProps = {
  readonly controller: SavedPlacePreviewUi;
  readonly onSourcePress?: (sourceLink: string) => void;
};

export function SavedPlacePreviewSurface({
  controller,
  onSourcePress,
}: SavedPlacePreviewSurfaceProps): React.JSX.Element | null {
  if (!controller.connected && controller.pendingRefs.length === 0) return null;
  return (
    <>
      {controller.connected ? (
        <SavedPlacePreviewPanel
          onClose={controller.close}
          onConsult={controller.consult}
          onRetry={controller.retry}
          {...(onSourcePress === undefined ? {} : { onSourcePress })}
          consultDisabled={controller.consultDisabled}
          state={controller.preview}
        />
      ) : null}
      {controller.pendingRefs.length > 0 ? (
        <SavedPlaceConsultationBanner
          disabled={controller.consultDisabled}
          onClear={controller.clearConsultation}
        />
      ) : null}
    </>
  );
}
