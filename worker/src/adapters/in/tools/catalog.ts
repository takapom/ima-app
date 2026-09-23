import { isPublicToolName } from '@worker/runtime/ports/tool-binding';
import { tool, type ToolExecutionOptions } from 'ai';
import * as v from 'valibot';
import { matchesDetailsRequest } from '@worker/application/ports/operations';
import { type CancellationToken } from '@worker/application/ports/context';
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
} from '@worker/runtime/ports/tool-binding';
import {
  cancellationError,
  invalidOutput,
  issue,
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
} from '@worker/adapters/in/tools/validation';
import {
  getPlaceDetailsToolSchema,
  searchPlacesToolSchema,
  submitCardsToolSchema,
} from '@worker/adapters/in/tools/schemas';
import { projectDetailsResult, projectSearchResult } from '@worker/adapters/in/tools/projection';
import {
  detailsResultForSavedFailures,
  mergeSavedDetailsFailures,
  resolveModelDetailsInput,
} from '@worker/adapters/in/tools/saved-reference-details';

const invocationOf = (options: ToolExecutionOptions): PublicToolInvocation => ({
  toolCallId: options.toolCallId,
  ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
});

const parseEnvelope = (input: unknown): { readonly input: unknown } | undefined => {
  const parsed = v.safeParse(v.strictObject({ input: v.unknown() }), input);
  return parsed.success ? parsed.output : undefined;
};

const searchPlaces = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
): Promise<SearchToolResult> => {
  const parsedInput = parseSearchInput(input);
  if (!parsedInput.ok) {
    return resultError(issue('INVALID_ARGUMENT', 'input', 'search_places input is invalid'));
  }
  const checked = runtimeFor(dependencies.runtime, 'search_places', invocation);
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
  return projectSearchResult(
    result,
    checked.runtime.context,
    dependencies.registry,
    dependencies.clock(),
    dependencies.modelContextFieldPolicy,
  );
};

const getPlaceDetails = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
): Promise<DetailsToolResult> => {
  const parsedInput = parseDetailsInput(input);
  if (!parsedInput.ok) {
    return resultError(issue('INVALID_ARGUMENT', 'input', 'get_place_details input is invalid'));
  }
  const checked = runtimeFor(dependencies.runtime, 'get_place_details', invocation);
  if (!checked.ok) return resultError(checked.error);
  const unsupported = unsupportedDetailField(checked.runtime.context, parsedInput.value);
  if (unsupported !== undefined) {
    return resultError(
      issue('UNSUPPORTED_FIELD', 'requests.fields', 'requested field is unavailable'),
    );
  }
  const directCandidateIssue = ownedCandidateIssue(
    dependencies.registry,
    checked.runtime.context,
    parsedInput.value.requests.flatMap((request) =>
      'candidateId' in request ? [request.candidateId] : [],
    ),
    'requests.candidateId',
  );
  if (directCandidateIssue !== undefined) return resultError(directCandidateIssue);

  const callId = checked.runtime.execution.callId;
  const admission = dependencies.readAdmission;
  let admissionSignal: AbortSignal | undefined;
  if (admission !== undefined) {
    const reserved = admission.reserve({
      callId,
      operation: 'get_place_details',
      ...(invocation.abortSignal === undefined ? {} : { signal: invocation.abortSignal }),
    });
    if (!reserved.ok) return resultError(reserved.error);
    admissionSignal = admission.signalFor(callId);
  }
  const readCancellation: CancellationToken =
    admissionSignal === undefined
      ? checked.runtime.cancellation
      : {
          isCancelled: () =>
            checked.runtime.cancellation.isCancelled() || admissionSignal?.aborted === true,
        };

  let resolved;
  try {
    resolved = await resolveModelDetailsInput(
      parsedInput.value,
      checked.runtime.context,
      checked.runtime.execution,
      readCancellation,
      {
        registry: dependencies.registry,
        resolver: dependencies.savedPlaceReferenceResolver,
      },
      admissionSignal,
    );
  } catch (error: unknown) {
    admission?.release(callId);
    throw error;
  }
  const cancelled = cancellationError<SafeGetPlaceDetailsOutput>(checked.runtime);
  if (cancelled !== undefined || readCancellation.isCancelled() || resolved.cancelled) {
    admission?.release(callId);
    return cancelled ?? resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
  }
  if (resolved.input === undefined) {
    admission?.release(callId);
    return detailsResultForSavedFailures(resolved.failures, resolved.warnings);
  }

  let returned: unknown;
  try {
    returned = await dependencies.details.read(
      resolved.input,
      checked.runtime.context,
      checked.runtime.execution,
      readCancellation,
    );
  } catch {
    if (readCancellation.isCancelled()) {
      return resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
    }
    return resultError(upstreamError());
  } finally {
    admission?.release(callId);
  }
  if (readCancellation.isCancelled()) {
    return resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
  }
  const result = parseDetailsResult(returned);
  if (result === undefined) return resultError(invalidOutput('result'));
  if (result.status === 'error') {
    return projectDetailsResult(
      result,
      checked.runtime.context,
      dependencies.registry,
      dependencies.clock(),
      dependencies.modelContextFieldPolicy,
      resolved.targetForCandidate,
    );
  }
  if (!matchesDetailsRequest(resolved.input, result.data)) {
    return resultError(mismatchedDetails());
  }
  const projected = projectDetailsResult(
    result,
    checked.runtime.context,
    dependencies.registry,
    dependencies.clock(),
    dependencies.modelContextFieldPolicy,
    resolved.targetForCandidate,
  );
  return mergeSavedDetailsFailures(projected, resolved.failures, resolved.warnings);
};

const submitCards = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
): Promise<SubmitToolResult> => {
  const checked = runtimeFor(dependencies.runtime, 'submit_cards', invocation);
  if (!checked.ok) {
    const result = submitInvalid('INVALID_ARGUMENT', checked.error.path, checked.error.message, 0);
    return dependencies.rejectSubmitInput?.(result) ?? result;
  }
  const parsedInput = parseSubmitInput(input);
  if (!parsedInput.ok) {
    const result = submitInvalid(
      'INVALID_ARGUMENT',
      'input',
      'submit_cards input is invalid',
      checked.runtime.remainingRepairs,
    );
    return dependencies.rejectSubmitInput?.(result) ?? result;
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
  if (name === 'search_places') return searchPlaces(input, invocation, dependencies);
  if (name === 'get_place_details') return getPlaceDetails(input, invocation, dependencies);
  if (name === 'submit_cards') return submitCards(input, invocation, dependencies);
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
      const result = submitInvalid('INVALID_ARGUMENT', null, 'tool action envelope is invalid', 0);
      return Promise.resolve(dependencies.rejectSubmitInput?.(result) ?? result);
    }
    const error = issue('INVALID_ARGUMENT', null, 'tool action envelope is invalid');
    return name === 'search_places'
      ? Promise.resolve(resultError<SafeSearchPlacesOutput>(error))
      : Promise.resolve(resultError<SafeGetPlaceDetailsOutput>(error));
  }
  if (name === 'search_places') {
    return searchPlaces(parsed.input, invocation, dependencies);
  }
  if (name === 'get_place_details') {
    return getPlaceDetails(parsed.input, invocation, dependencies);
  }
  return submitCards(parsed.input, invocation, dependencies);
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
  if (name === 'search_places') return searchPlaces(input, invocation, dependencies);
  if (name === 'get_place_details') return getPlaceDetails(input, invocation, dependencies);
  return submitCards(input, invocation, dependencies);
};

export const createPublicToolSet = (dependencies: ToolBindingDependencies): PublicToolSet =>
  ({
    search_places: tool<SearchToolEnvelope, SearchToolResult>({
      description: [
        '指定地域の店舗をホットペッパーで検索します。keywordは空白区切りのAND検索で、areaに指定した地域名もqueryと同じkeywordへ連結されます。',
        'queryには掲載情報に現れる短い語だけを使い、「甘いもの」「まったり」のような要望表現はスイーツ・カフェ・居酒屋などのジャンル語へ置き換えてください。',
        '0件のときは語を減らすか別のジャンル語で再検索し、検索していない状態を候補なしと断定しないでください。',
        '営業中で絞り込む検索はありません。営業時間は掲載文であり、今の営業・到着時の営業・空席を保証しません。未確認と明示してください。徒歩・終電の条件も保証しません。',
      ].join('\n'),
      inputSchema: searchPlacesToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('search_places', input, dependencies, invocationOf(options)),
    }),
    get_place_details: tool<DetailsToolEnvelope, DetailsToolResult>({
      description: [
        '登録済み候補の要求したfieldsだけを取得します。未対応のfieldは推測せず未対応として扱ってください。',
        'カード提示の1st step: 提案する候補をまとめて1回のget_place_detailsへ渡します。requestsは配列なので候補ごとに呼び分けず、各要素のfieldsへidentity、opening_hours、price、photos、facilitiesを指定してください。',
        'identityとopening_hoursは確定に必須です。price、photos、facilitiesはカードの表示に使うので、利用可能なら同じ呼び出しで併せて取得してください。',
        '取得できたobservationIdは、次のstepのsubmit_cardsで各候補のevidenceIdsへ入れてください。読み取りと確定は同じstepにできません。',
        '取得できなかったfieldは未取得として扱い、そのまま提案を続けてください。写真や価格が無い店舗でも提案できます。',
      ].join('\n'),
      inputSchema: getPlaceDetailsToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('get_place_details', input, dependencies, invocationOf(options)),
    }),
    submit_cards: tool<SubmitToolEnvelope, SubmitToolResult>({
      description: [
        '根拠付きのカードとmessageを検証し、1回だけ確定します。',
        'カード提示の2nd step: 先のstepで提案する候補をまとめて1回のget_place_detailsへ渡し、各候補のidentityとopening_hoursを取得してください。',
        '各カードのevidenceIdsへその候補のidentityとopening_hoursのobservationIdを入れてください。この2つが揃ったカードだけが確定できます。読み取りと確定は同じstepにできません。',
        'price、photos、facilitiesも取得できていれば、そのobservationIdを同じevidenceIdsへ加えてください。引用しなかったfieldはカードに表示されません。',
      ].join('\n'),
      inputSchema: submitCardsToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('submit_cards', input, dependencies, invocationOf(options)),
    }),
  }) satisfies PublicToolSet;

export { isPublicToolName } from '@worker/runtime/ports/tool-binding';

export const getPublicTool = (
  tools: PublicToolSet,
  name: string,
): PublicToolSet[PublicToolName] | undefined => (isPublicToolName(name) ? tools[name] : undefined);
