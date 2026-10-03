import { useCallback, useEffect, useState } from 'react';
import type { AssistantResponseState } from '@mobile/journey/state/assistant-response';
import type { ReadyPhotoImage, RememberPhoto } from '@mobile/journey/state/photo-image-state';
import {
  candidateDetailInitial,
  closeCandidateDetail,
  openCandidateDetail,
  reconcileCandidateDetail,
  reconcileCandidateDetailScope,
} from '@mobile/journey/state/candidate-detail';
import { cardRenderNow } from '@mobile/journey/presentation/candidate-card-view';
import { toCandidateDetailViewModel } from '@mobile/journey/presentation/candidate-detail-view';

export const useCandidateDetail = (
  response: AssistantResponseState | null,
  candidateOrder: readonly string[],
  now: string | undefined,
  photoCandidateIds: readonly string[] = [],
) => {
  const scope = response?.cardSetId ?? null;
  const [selection, setSelection] = useState({ scope, detail: candidateDetailInitial });
  const [photos, setPhotos] = useState<readonly ReadyPhotoImage[]>([]);
  const at = cardRenderNow(now);
  const cards = response?.cards;
  const available = (
    cards === null || cards === undefined ? [] : [cards.hero, ...cards.alts]
  ).filter(
    (card) =>
      candidateOrder.includes(card.candidateId) &&
      (toCandidateDetailViewModel(card, at).attributions.length > 0 ||
        photoCandidateIds.includes(card.candidateId)),
  );
  const ids = available.map((card) => card.candidateId);
  const detail = reconcileCandidateDetailScope(selection.detail, selection.scope, scope, ids);
  // Hide a stale selection during render, then forget it so it cannot reopen if an ID returns.
  useEffect(() => {
    if (selection.detail !== detail) setSelection({ scope, detail });
  }, [detail, scope, selection.detail]);
  const rememberPhoto: RememberPhoto = useCallback((image: ReadyPhotoImage) => {
    setPhotos((current) => [...current, image]);
    return () => setPhotos((current) => current.filter((item) => item !== image));
  }, []);
  const close = useCallback(
    (): void => setSelection({ scope, detail: closeCandidateDetail(detail) }),
    [scope, detail],
  );
  return {
    card: available.find((card) => card.candidateId === detail.openCandidateId) ?? null,
    now: at,
    photos,
    rememberPhoto,
    open: (candidateId: string): void => {
      setSelection({
        scope,
        detail: reconcileCandidateDetail(openCandidateDetail(detail, candidateId), ids),
      });
    },
    close,
  };
};
