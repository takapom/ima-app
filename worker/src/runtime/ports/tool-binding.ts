import type { Tool, ToolExecutionOptions } from 'ai';
import type {
  CancellationToken,
  HarnessContext,
  ToolExecutionContext,
} from '@worker/application/ports/context';
import type { DetailField } from '@worker/domain/primitives';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type {
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { Issue } from '@worker/domain/issue';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type { Result } from '@worker/domain/result';
import type { RespondInput } from '@worker/application/ports/model';
import type {
  RespondInvalid,
  RespondPort,
  RespondPortResult,
} from '@worker/application/ports/submission';

export const PUBLIC_TOOL_NAMES = ['search_places', 'get_place_details', 'respond'] as const;

export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];

export type PublicToolInvocation = Pick<ToolExecutionOptions, 'toolCallId' | 'abortSignal'>;

/** Reserves a Details read slot and its abort signal before the tool boundary calls the read Port. */
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
  /** M10 supplies the remaining respond repair budget for this invocation. */
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
export type DetailsToolEnvelope = PublicToolEnvelope<GetPlaceDetailsInput>;
export type RespondToolEnvelope = PublicToolEnvelope<RespondInput>;

export type ToolBindingDependencies = {
  /** Read-only candidate authorization; the registry remains the Application owner. */
  readonly registry: Pick<CandidateObservationRegistryPort, 'readCandidate' | 'readObservation'>;
  /** Server-owned wall clock sampled after a read Port settles for freshness projection. */
  readonly clock: () => string;
  readonly search: PlaceSearchPort;
  readonly details: PlaceDetailsPort;
  readonly respond: RespondPort;
  /** Charges and reports respond failures rejected before the Application Port is reached. */
  /** `input` is the unparsed respond input, so the runtime can tell which kind was refused. */
  readonly rejectRespondInput?: (result: RespondInvalid, input: unknown) => RespondInvalid;
  readonly readAdmission?: ToolReadAdmission;
  /** Host-evaluated policy for the SDK model-input surface. Omitted means deny by default. */
  readonly modelContextFieldPolicy?: ModelContextFieldPolicy;
  readonly runtime: ToolRuntimeFactory;
};

export type RespondToolResult = RespondPortResult;

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

type SearchFieldValue<Key extends 'identity' | 'openingHours' | 'price' | 'facilities'> =
  KnownValue<RawSearchCandidate[Key]>;

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
    readonly facilities: ModelSafeFieldResult<SearchFieldValue<'facilities'>>;
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

export type SafeGetPlaceDetailsOutput = {
  readonly items: {
    readonly candidateId: string;
    readonly fields: SafePlaceFields;
  }[];
};

export type SearchToolResult = Result<SafeSearchPlacesOutput>;
export type DetailsToolResult = Result<SafeGetPlaceDetailsOutput>;

export type PublicToolResult = SearchToolResult | DetailsToolResult | RespondToolResult;

export type PublicToolSet = {
  readonly search_places: Tool<SearchToolEnvelope, SearchToolResult>;
  readonly get_place_details: Tool<DetailsToolEnvelope, DetailsToolResult>;
  readonly respond: Tool<RespondToolEnvelope, RespondToolResult>;
};

export type PublicToolInput = SearchPlacesInput | GetPlaceDetailsInput | RespondInput;

export const isPublicToolName = (name: string): name is PublicToolName =>
  name === 'search_places' || name === 'get_place_details' || name === 'respond';
