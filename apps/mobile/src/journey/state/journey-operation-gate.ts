export type JourneyOperationToken = {
  readonly generation: number;
  readonly noticeToken: number;
};

/** A result may update state only while its response context is still current. */
export const canCommitJourneyOperation = (
  current: JourneyOperationToken,
  started: JourneyOperationToken,
): boolean => current.generation === started.generation;

/** A result may update the user-facing notice only if no newer action owns it. */
export const canCommitJourneyNotice = (
  current: JourneyOperationToken,
  started: JourneyOperationToken,
): boolean =>
  canCommitJourneyOperation(current, started) && current.noticeToken === started.noticeToken;
