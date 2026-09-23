import type { Tool, ToolExecutionOptions } from 'ai';
import type {
  CancellationToken,
  HarnessContext,
  ToolExecutionContext,
} from '@worker/application/ports/context';
import type { CandidateId, DetailField } from '@worker/domain/primitives';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type {
  GetPlaceDetailsOutput,
  ModelGetPlaceDetailsInput,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { Issue } from '@worker/domain/issue';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type { Result } from '@worker/domain/result';
import type { SubmitCardsInput } from '@worker/application/ports/model';
import type {
  SubmitCardsInvalid,
  SubmitCardsPort,
  SubmitCardsPortResult,
} from '@worker/application/ports/submission';
import type { SavedPlaceRef } from '@worker/domain/primitives';

export const PUBLIC_TOOL_NAMES = ['search_places', 'get_place_details', 'submit_cards'] as const;

export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];

export type PublicToolInvocation = Pick<ToolExecutionOptions, 'toolCallId' | 'abortSignal'>;

/** Worker-owned async boundary for resolving one model-selected saved reference. */
export type SavedPlaceReferenceResolutionRequest = {
  readonly savedPlaceRef: SavedPlaceRef;
  /** Fields selected for this reference; the Worker may use them for the fresh provider read. */
  readonly fields: readonly DetailField[];
  readonly context: HarnessContext;
  readonly execution: ToolExecutionContext;
  readonly cancellation: CancellationToken;
  readonly signal?: AbortSignal;
};

export type SavedPlaceReferenceResolution =
  | {
      readonly status: 'ok';
      readonly candidateId: CandidateId;
      readonly warnings?: readonly Issue[];
    }
  | { readonly status: 'error'; readonly error: Issue };

/** The Worker RPC result is untrusted until the tool boundary validates this shape. */
export type SavedPlaceReferenceResolver = (
  request: SavedPlaceReferenceResolutionRequest,
) => Promise<unknown>;

/** Reserves a Details read slot before a saved-reference resolver can perform provider I/O. */
export type ToolReadAdmission = {
  readonly reserve: (input: {
    readonly callId: string;
    readonly operation: 'get_place_details';
    readonly signal?: AbortSignal;
  }) => { readonly ok: true } | { readonly ok: false; readonly error: Issue };
  readonly signalFor: (callId: string) => AbortSignal | undefined;
  readonly release: (callId: string) => void;
};

export type ToolRuntime = {
  readonly context: HarnessContext;
  readonly execution: ToolExecutionContext;
  readonly cancellation: CancellationToken;
  /** M10 supplies the remaining submit repair budget for this invocation. */
  readonly remainingRepairs: number;
};

/** Supplies the server context for one tool invocation; M10 owns the per-turn state. */
export type ToolRuntimeFactory = (
  operation: PublicToolName,
  invocation: PublicToolInvocation,
) => unknown;

/**
 * Model-facing tool arguments wrap the input in one object, because provider function
 * parameters must be a root object while search input is a union of modes.
 */
export type PublicToolEnvelope<Input> = {
  readonly input: Input;
};

export type SearchToolEnvelope = PublicToolEnvelope<SearchPlacesInput>;
export type DetailsToolEnvelope = PublicToolEnvelope<ModelGetPlaceDetailsInput>;
export type SubmitToolEnvelope = PublicToolEnvelope<SubmitCardsInput>;

export type ToolBindingDependencies = {
  /** Read-only candidate authorization; the registry remains the Application owner. */
  readonly registry: Pick<CandidateObservationRegistryPort, 'readCandidate' | 'readObservation'>;
  /** Server-owned wall clock sampled after a read Port settles for freshness projection. */
  readonly clock: () => string;
  readonly search: PlaceSearchPort;
  readonly details: PlaceDetailsPort;
  readonly submit: SubmitCardsPort;
  /** Charges and reports submit failures rejected before the Application Port is reached. */
  readonly rejectSubmitInput?: (result: SubmitCardsInvalid) => SubmitCardsInvalid;
  readonly readAdmission?: ToolReadAdmission;
  /** Optional Worker-owned boundary for one model-selected saved reference. */
  readonly savedPlaceReferenceResolver?: SavedPlaceReferenceResolver;
  /** Host-evaluated policy for the SDK model-input surface. Omitted means deny by default. */
  readonly modelContextFieldPolicy?: ModelContextFieldPolicy;
  readonly runtime: ToolRuntimeFactory;
};

export type SubmitToolResult = SubmitCardsPortResult;

type KnownValue<T> = T extends { status: 'known'; observations: ReadonlyArray<infer Observation> }
  ? Observation extends { value: infer Value }
    ? Value
    : never
  : never;

type RawDetailsFields = GetPlaceDetailsOutput['items'][number]['fields'];
type RawSearchCandidate = SearchPlacesOutput['candidates'][number];

export type DetailsFieldValue<Key extends keyof RawDetailsFields> = KnownValue<
  NonNullable<RawDetailsFields[Key]>
>;

type SearchFieldValue<Key extends 'identity' | 'openingHours' | 'price'> = KnownValue<
  RawSearchCandidate[Key]
>;

export type ModelSafeObservation<T> = {
  readonly observationId: string;
  readonly candidateId: string;
  readonly field: DetailField;
  readonly value: T;
  readonly basis: 'provider_reported' | 'computed';
  readonly fetchedAt: string;
  readonly sourceUpdatedAt: string | null;
  readonly expiresAt: string;
  readonly freshUntil: string | null;
  readonly sources: readonly {
    readonly provider: string;
    readonly attribution: string | null;
    readonly publicUrl: string | null;
  }[];
};

export type ModelSafeFieldResult<T> =
  | { readonly status: 'known'; readonly observations: ModelSafeObservation<T>[] }
  | {
      readonly status: 'unknown' | 'unsupported' | 'not_applicable' | 'withheld' | 'stale';
      readonly reason: string;
    }
  | { readonly status: 'error'; readonly error: Issue };

export type SafeSearchPlacesOutput = {
  readonly searchId: string;
  readonly candidates: {
    readonly candidateId: string;
    readonly identity: ModelSafeFieldResult<SearchFieldValue<'identity'>>;
    readonly openingHours: ModelSafeFieldResult<SearchFieldValue<'openingHours'>>;
    readonly price: ModelSafeFieldResult<SearchFieldValue<'price'>>;
  }[];
  readonly applied: {
    readonly areaDescription: string;
    readonly excludedCount: number;
  };
  readonly nextCursor: string | null;
  readonly coverage: 'provider_results';
};

export type SafePlaceFields = {
  readonly identity?: ModelSafeFieldResult<DetailsFieldValue<'identity'>>;
  readonly opening_hours?: ModelSafeFieldResult<DetailsFieldValue<'opening_hours'>>;
  readonly price?: ModelSafeFieldResult<DetailsFieldValue<'price'>>;
  readonly photos?: ModelSafeFieldResult<DetailsFieldValue<'photos'>>;
  readonly contact?: ModelSafeFieldResult<DetailsFieldValue<'contact'>>;
  readonly facilities?: ModelSafeFieldResult<DetailsFieldValue<'facilities'>>;
};

export type SafeDetailsTarget =
  | { readonly candidateId: string; readonly savedPlaceRef?: SavedPlaceRef }
  | { readonly savedPlaceRef: SavedPlaceRef; readonly candidateId?: never };

export type SafeGetPlaceDetailsOutput = {
  readonly items: (
    | {
        readonly candidateId: string;
        readonly savedPlaceRef?: SavedPlaceRef;
        readonly fields: SafePlaceFields;
      }
    | {
        readonly savedPlaceRef: SavedPlaceRef;
        readonly fields: SafePlaceFields;
      }
  )[];
};

export type SearchToolResult = Result<SafeSearchPlacesOutput>;
export type DetailsToolResult = Result<SafeGetPlaceDetailsOutput>;

export type PublicToolResult = SearchToolResult | DetailsToolResult | SubmitToolResult;

export type PublicToolSet = {
  readonly search_places: Tool<SearchToolEnvelope, SearchToolResult>;
  readonly get_place_details: Tool<DetailsToolEnvelope, DetailsToolResult>;
  readonly submit_cards: Tool<SubmitToolEnvelope, SubmitToolResult>;
};

export type PublicToolInput = SearchPlacesInput | ModelGetPlaceDetailsInput | SubmitCardsInput;

export const isPublicToolName = (name: string): name is PublicToolName =>
  name === 'search_places' || name === 'get_place_details' || name === 'submit_cards';
