import type { AssistantResponse } from '@ima/contracts';
import type { CommittedResponse } from '@ima/core';
import {
  mapCommittedResponseToPublic,
  prepareRuntimePhotoResolver,
  type RuntimePhotoTokenResolver,
  type RuntimePublicResponseDependencies,
  type RuntimePublicResponseMetadata,
} from '@worker/runtime/response/runtime-response';

export type RuntimePhotoPreparationState = {
  resolver: RuntimePhotoTokenResolver | undefined;
  prepared: boolean;
};

export const createRuntimePhotoPreparationState = (): RuntimePhotoPreparationState => ({
  resolver: undefined,
  prepared: false,
});

export const resetRuntimePhotoPreparationState = (state: RuntimePhotoPreparationState): void => {
  state.resolver = undefined;
  state.prepared = false;
};

export const mapPreparedRuntimeResponse = (
  response: CommittedResponse,
  dependencies: RuntimePublicResponseDependencies,
  metadata: RuntimePublicResponseMetadata,
  photoResolver: RuntimePhotoTokenResolver | undefined,
): AssistantResponse => {
  const publicOptions = {
    textRetention: dependencies.textRetention,
    ...(dependencies.resolveCardEvidence === undefined
      ? {}
      : { resolveCardEvidence: dependencies.resolveCardEvidence }),
    ...(dependencies.cardSetId === undefined ? {} : { cardSetId: dependencies.cardSetId }),
    ...(photoResolver === undefined ? {} : { resolvePhotoToken: photoResolver }),
    ...metadata,
  };
  return mapCommittedResponseToPublic(response, publicOptions);
};

export const prepareAndMapRuntimeResponse = async (input: {
  readonly response: CommittedResponse;
  readonly dependencies: RuntimePublicResponseDependencies;
  readonly metadata: RuntimePublicResponseMetadata;
  readonly now: string;
  readonly state: RuntimePhotoPreparationState;
  readonly isActive: () => boolean;
}): Promise<AssistantResponse | undefined> => {
  const photoResolver = input.state.prepared
    ? input.state.resolver
    : await prepareRuntimePhotoResolver(
        input.dependencies,
        input.response,
        input.metadata,
        input.now,
      );
  if (!input.isActive()) return undefined;
  input.state.resolver = photoResolver;
  input.state.prepared = true;
  return mapPreparedRuntimeResponse(
    input.response,
    input.dependencies,
    input.metadata,
    photoResolver,
  );
};
