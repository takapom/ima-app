import type { AssistantResponse } from '@ima/contracts';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import {
  mapCommittedResponseToPublic,
  type RuntimePhotoTokenResolver,
  type RuntimePublicResponseDependencies,
  type RuntimePublicResponseMetadata,
} from '@worker/runtime/response/runtime-response';

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
