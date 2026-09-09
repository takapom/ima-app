import { tool, type ToolExecutionOptions } from 'ai';
import * as v from 'valibot';
import {
  ModelActionMetadataSchema,
  matchesDetailsRequest,
  type ModelActionMetadata,
} from '@ima/core';
import type {
  DetailsToolResult,
  DetailsToolEnvelope,
  PublicToolInvocation,
  PublicToolName,
  PublicToolResult,
  PublicToolSet,
  SafeGetPlaceDetailsOutput,
  SafeSearchPlacesOutput,
  SearchToolEnvelope,
  SearchToolResult,
  SubmitToolEnvelope,
  SubmitToolResult,
  ToolBindingDependencies,
} from './types';
import {
  cancellationError,
  invalidOutput,
  issue,
  mismatchedTravelContext,
  mismatchedDetails,
  ownedCandidateIssue,
  parseDetailsInput,
  parseDetailsResult,
  parseSearchInput,
  parseSearchResult,
  parseSubmitInput,
  parseSubmitResult,
  resultError,
  runtimeFor,
  submitCancellationError,
  submitInvalid,
  unsupportedDetailField,
  upstreamError,
} from './validation';
import {
  getPlaceDetailsToolSchema,
  searchPlacesToolSchema,
  submitCardsToolSchema,
} from './schemas';
import { projectDetailsResult, projectSearchResult } from './projection';

const invocationOf = (options: ToolExecutionOptions): PublicToolInvocation => ({
  toolCallId: options.toolCallId,
  ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
});

const EMPTY_METADATA: ModelActionMetadata = {};

const parseEnvelope = (
  input: unknown,
): { readonly input: unknown; readonly metadata: ModelActionMetadata } | undefined => {
  const parsed = v.safeParse(
    v.strictObject({ input: v.unknown(), metadata: ModelActionMetadataSchema }),
    input,
  );
  return parsed.success ? parsed.output : undefined;
};

const searchPlaces = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
  metadata: ModelActionMetadata,
): Promise<SearchToolResult> => {
  const parsedInput = parseSearchInput(input);
  if (!parsedInput.ok) {
    return resultError(issue('INVALID_ARGUMENT', 'input', 'search_places input is invalid'));
  }
  const checked = runtimeFor(dependencies.runtime, 'search_places', invocation, metadata);
  if (!checked.ok) return resultError(checked.error);
  const excludedCandidateIssue =
    parsedInput.value.mode === 'search'
      ? ownedCandidateIssue(
          dependencies.registry,
          checked.runtime.context,
          parsedInput.value.excludeCandidateIds,
          'excludeCandidateIds',
        )
      : undefined;
  if (excludedCandidateIssue !== undefined) return resultError(excludedCandidateIssue);
  // A continuation cursor is opaque; the search Application verifies its signature and scope.
  const cancelled = cancellationError<SafeSearchPlacesOutput>(checked.runtime);
  if (cancelled !== undefined) return cancelled;

  let returned: unknown;
  try {
    returned = await dependencies.search.search(
      parsedInput.value,
      checked.runtime.context,
      checked.runtime.execution,
      checked.runtime.cancellation,
    );
  } catch {
    if (checked.runtime.cancellation.isCancelled()) {
      return resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
    }
    return resultError(upstreamError());
  }
  if (checked.runtime.cancellation.isCancelled()) {
    return resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
  }
  const result = parseSearchResult(returned);
  if (result === undefined) return resultError(invalidOutput('result'));
  if (result.status === 'error') {
    return projectSearchResult(result, checked.runtime.context, dependencies.registry);
  }
  return projectSearchResult(result, checked.runtime.context, dependencies.registry);
};

const getPlaceDetails = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
  metadata: ModelActionMetadata,
): Promise<DetailsToolResult> => {
  const parsedInput = parseDetailsInput(input);
  if (!parsedInput.ok) {
    return resultError(issue('INVALID_ARGUMENT', 'input', 'get_place_details input is invalid'));
  }
  const checked = runtimeFor(dependencies.runtime, 'get_place_details', invocation, metadata);
  if (!checked.ok) return resultError(checked.error);
  const candidateIssue = ownedCandidateIssue(
    dependencies.registry,
    checked.runtime.context,
    parsedInput.value.requests.map((request) => request.candidateId),
    'requests.candidateId',
  );
  if (candidateIssue !== undefined) return resultError(candidateIssue);
  const unsupported = unsupportedDetailField(checked.runtime.context, parsedInput.value);
  if (unsupported !== undefined) {
    return resultError(
      issue('UNSUPPORTED_FIELD', 'requests.fields', 'requested field is unavailable'),
    );
  }
  const mismatchedTravel = mismatchedTravelContext(checked.runtime.context, parsedInput.value);
  if (mismatchedTravel !== undefined) {
    return resultError(
      issue(
        'CONSTRAINT_VIOLATION',
        `travelContext.${mismatchedTravel}`,
        'requested travel context is not harness-approved',
      ),
    );
  }
  const cancelled = cancellationError<SafeGetPlaceDetailsOutput>(checked.runtime);
  if (cancelled !== undefined) return cancelled;

  let returned: unknown;
  try {
    returned = await dependencies.details.read(
      parsedInput.value,
      checked.runtime.context,
      checked.runtime.execution,
      checked.runtime.cancellation,
    );
  } catch {
    if (checked.runtime.cancellation.isCancelled()) {
      return resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
    }
    return resultError(upstreamError());
  }
  if (checked.runtime.cancellation.isCancelled()) {
    return resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
  }
  const result = parseDetailsResult(returned);
  if (result === undefined) return resultError(invalidOutput('result'));
  if (result.status === 'error') {
    return projectDetailsResult(result, checked.runtime.context, dependencies.registry);
  }
  if (!matchesDetailsRequest(parsedInput.value, result.data)) {
    return resultError(mismatchedDetails());
  }
  return projectDetailsResult(result, checked.runtime.context, dependencies.registry);
};

const submitCards = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
  metadata: ModelActionMetadata,
): Promise<SubmitToolResult> => {
  const checked = runtimeFor(dependencies.runtime, 'submit_cards', invocation, metadata);
  if (!checked.ok) {
    return submitInvalid('INVALID_ARGUMENT', null, 'submit execution context is invalid', 0);
  }
  const parsedInput = parseSubmitInput(input);
  if (!parsedInput.ok) {
    return submitInvalid(
      'INVALID_ARGUMENT',
      'input',
      'submit_cards input is invalid',
      checked.runtime.remainingRepairs,
    );
  }
  const cancelled = submitCancellationError(checked.runtime);
  if (cancelled !== undefined) return cancelled;

  const returned = await dependencies.submit.submit(
    parsedInput.value,
    checked.runtime.execution,
    checked.runtime.cancellation,
  );
  const result = parseSubmitResult(returned);
  if (result === undefined) {
    throw new Error('submit_cards application returned an invalid result');
  }
  return result;
};

/** Binds an already-unwrapped Core input; model-facing callers use invokePublicToolEnvelope. */
export function invokePublicTool(
  name: 'search_places',
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<SearchToolResult>;
export function invokePublicTool(
  name: 'get_place_details',
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<DetailsToolResult>;
export function invokePublicTool(
  name: 'submit_cards',
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<SubmitToolResult>;
export function invokePublicTool(
  name: PublicToolName,
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<PublicToolResult> {
  if (name === 'search_places')
    return searchPlaces(input, invocation, dependencies, EMPTY_METADATA);
  if (name === 'get_place_details')
    return getPlaceDetails(input, invocation, dependencies, EMPTY_METADATA);
  if (name === 'submit_cards') return submitCards(input, invocation, dependencies, EMPTY_METADATA);
  return Promise.resolve(resultError<never>(issue('INVALID_ARGUMENT', null, 'unknown tool name')));
}

export function invokePublicToolEnvelope(
  name: 'search_places',
  envelope: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<SearchToolResult>;
export function invokePublicToolEnvelope(
  name: 'get_place_details',
  envelope: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<DetailsToolResult>;
export function invokePublicToolEnvelope(
  name: 'submit_cards',
  envelope: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<SubmitToolResult>;
export function invokePublicToolEnvelope(
  name: string,
  envelope: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<PublicToolResult> {
  if (!isPublicToolName(name)) {
    return Promise.resolve(
      resultError<never>(issue('INVALID_ARGUMENT', null, 'unknown tool name')),
    );
  }
  const parsed = parseEnvelope(envelope);
  if (parsed === undefined) {
    if (name === 'submit_cards') {
      return Promise.resolve(
        submitInvalid('INVALID_ARGUMENT', null, 'tool action envelope is invalid', 0),
      );
    }
    const error = issue('INVALID_ARGUMENT', null, 'tool action envelope is invalid');
    return name === 'search_places'
      ? Promise.resolve(resultError<SafeSearchPlacesOutput>(error))
      : Promise.resolve(resultError<SafeGetPlaceDetailsOutput>(error));
  }
  if (name === 'search_places') {
    return searchPlaces(parsed.input, invocation, dependencies, parsed.metadata);
  }
  if (name === 'get_place_details') {
    return getPlaceDetails(parsed.input, invocation, dependencies, parsed.metadata);
  }
  return submitCards(parsed.input, invocation, dependencies, parsed.metadata);
}

export const invokePublicToolByName = (
  name: string,
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<PublicToolResult> => {
  if (!isPublicToolName(name)) {
    return Promise.resolve(
      resultError<never>(issue('INVALID_ARGUMENT', null, 'unknown tool name')),
    );
  }
  if (name === 'search_places')
    return searchPlaces(input, invocation, dependencies, EMPTY_METADATA);
  if (name === 'get_place_details')
    return getPlaceDetails(input, invocation, dependencies, EMPTY_METADATA);
  return submitCards(input, invocation, dependencies, EMPTY_METADATA);
};

export const createPublicToolSet = (dependencies: ToolBindingDependencies): PublicToolSet =>
  ({
    search_places: tool<SearchToolEnvelope, SearchToolResult>({
      description:
        'Search places in the supplied area. It does not guarantee opening, walking, or last-train conditions.',
      inputSchema: searchPlacesToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('search_places', input, dependencies, invocationOf(options)),
    }),
    get_place_details: tool<DetailsToolEnvelope, DetailsToolResult>({
      description:
        'Read only the requested fields for registered candidates. Unsupported fields are reported instead of inferred.',
      inputSchema: getPlaceDetailsToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('get_place_details', input, dependencies, invocationOf(options)),
    }),
    submit_cards: tool<SubmitToolEnvelope, SubmitToolResult>({
      description:
        'Submit grounded cards and message for application validation and one-time commitment.',
      inputSchema: submitCardsToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('submit_cards', input, dependencies, invocationOf(options)),
    }),
  }) satisfies PublicToolSet;

export const isPublicToolName = (name: string): name is PublicToolName =>
  name === 'search_places' || name === 'get_place_details' || name === 'submit_cards';

export const getPublicTool = (
  tools: PublicToolSet,
  name: string,
): PublicToolSet[PublicToolName] | undefined => (isPublicToolName(name) ? tools[name] : undefined);
