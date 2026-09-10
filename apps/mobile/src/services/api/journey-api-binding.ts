import type {
  CreateThreadRequest,
  LifecycleCommand,
  SearchRequest,
  ThreadTurnRequest,
} from '@ima/contracts';
import type { JourneyConditions } from '../../state/journey-input';
import type { JourneyApiController } from './journey-controller-types';
import type { JourneyPhotoClient } from './photo-client';

export type JourneyApiSubmitContext = {
  readonly conditions: JourneyConditions;
  readonly removedChipLabels: readonly string[];
  /** The card set currently visible to the user, if any. */
  readonly cardSetId: string | null;
  readonly promotedCandidateId: string | null;
  readonly selectedCandidateId: string | null;
  readonly candidateOrder: readonly string[];
  readonly excludeCandidateIds: readonly string[];
};

export type JourneyApiSearchFactoryInput = {
  readonly threadId: string;
  readonly revision: number;
  readonly query: string;
  readonly context: JourneyApiSubmitContext;
};

export type JourneyApiTurnFactoryInput = JourneyApiSearchFactoryInput & {
  readonly turnId: string | null;
};

export type JourneyApiCancelFactoryInput = {
  readonly threadId: string;
  readonly revision: number;
  readonly turnId: string | null;
};

export type JourneyApiRequestFactory = {
  readonly createThread: () => CreateThreadRequest;
  readonly search: (input: JourneyApiSearchFactoryInput) => SearchRequest;
  readonly turn: (input: JourneyApiTurnFactoryInput) => ThreadTurnRequest;
  readonly cancel: (input: JourneyApiCancelFactoryInput) => LifecycleCommand;
};

export type JourneyApiControllerBinding = {
  readonly controller: JourneyApiController;
  readonly requests: JourneyApiRequestFactory;
  /** Authenticated binary photo access; absent when the host has no API composition. */
  readonly photoClient?: JourneyPhotoClient;
};
