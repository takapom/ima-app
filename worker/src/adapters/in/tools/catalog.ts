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
  RespondToolEnvelope,
  RespondToolResult,
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
  parseRespondInput,
  parseRespondResult,
  resultError,
  runtimeFor,
  respondCancellationError,
  respondInvalid,
  unsupportedDetailField,
  upstreamError,
} from '@worker/adapters/in/tools/validation';
import {
  getPlaceDetailsToolSchema,
  searchPlacesToolSchema,
  respondToolSchema,
} from '@worker/adapters/in/tools/schemas';
import { projectDetailsResult, projectSearchResult } from '@worker/adapters/in/tools/projection';

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
  const candidateIssue = ownedCandidateIssue(
    dependencies.registry,
    checked.runtime.context,
    parsedInput.value.requests.map((request) => request.candidateId),
    'requests.candidateId',
  );
  if (candidateIssue !== undefined) return resultError(candidateIssue);

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

  const cancelled = cancellationError<SafeGetPlaceDetailsOutput>(checked.runtime);
  if (cancelled !== undefined || readCancellation.isCancelled()) {
    admission?.release(callId);
    return cancelled ?? resultError(issue('CANCELLED', null, 'tool execution was cancelled'));
  }

  let returned: unknown;
  try {
    returned = await dependencies.details.read(
      parsedInput.value,
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
    );
  }
  if (!matchesDetailsRequest(parsedInput.value, result.data)) {
    return resultError(mismatchedDetails());
  }
  return projectDetailsResult(
    result,
    checked.runtime.context,
    dependencies.registry,
    dependencies.clock(),
    dependencies.modelContextFieldPolicy,
  );
};

const respond = async (
  input: unknown,
  invocation: PublicToolInvocation,
  dependencies: ToolBindingDependencies,
): Promise<RespondToolResult> => {
  const checked = runtimeFor(dependencies.runtime, 'respond', invocation);
  if (!checked.ok) {
    const result = respondInvalid('INVALID_ARGUMENT', checked.error.path, checked.error.message, 0);
    return dependencies.rejectRespondInput?.(result) ?? result;
  }
  const parsedInput = parseRespondInput(input);
  if (!parsedInput.ok) {
    const result = respondInvalid(
      'INVALID_ARGUMENT',
      'input',
      'respond input is invalid',
      checked.runtime.remainingRepairs,
    );
    return dependencies.rejectRespondInput?.(result) ?? result;
  }
  const cancelled = respondCancellationError(checked.runtime);
  if (cancelled !== undefined) return cancelled;

  const returned = await dependencies.respond.respond(
    parsedInput.value,
    checked.runtime.execution,
    checked.runtime.cancellation,
  );
  const result = parseRespondResult(returned);
  if (result === undefined) {
    throw new Error('respond application returned an invalid result');
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
  name: 'respond',
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<RespondToolResult>;
export function invokePublicTool(
  name: PublicToolName,
  input: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<PublicToolResult> {
  if (name === 'search_places') return searchPlaces(input, invocation, dependencies);
  if (name === 'get_place_details') return getPlaceDetails(input, invocation, dependencies);
  if (name === 'respond') return respond(input, invocation, dependencies);
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
  name: 'respond',
  envelope: unknown,
  dependencies: ToolBindingDependencies,
  invocation: PublicToolInvocation,
): Promise<RespondToolResult>;
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
    if (name === 'respond') {
      const result = respondInvalid('INVALID_ARGUMENT', null, 'tool action envelope is invalid', 0);
      return Promise.resolve(dependencies.rejectRespondInput?.(result) ?? result);
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
  return respond(parsed.input, invocation, dependencies);
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
  return respond(input, invocation, dependencies);
};

export const createPublicToolSet = (dependencies: ToolBindingDependencies): PublicToolSet =>
  ({
    search_places: tool<SearchToolEnvelope, SearchToolResult>({
      description: [
        '指定地域の店舗をホットペッパーで検索します。keywordは空白区切りのAND検索で、areaに指定した地域名もqueryと同じkeywordへ連結されます。',
        'queryには掲載情報に現れる短い語だけを使い、「甘いもの」「まったり」のような要望表現はスイーツ・カフェ・居酒屋などのジャンル語へ置き換えてください。',
        '0件のときは語を減らすか別のジャンル語で再検索し、検索していない状態を候補なしと断定しないでください。',
        '営業中で絞り込む検索はありません。営業時間は掲載文であり、今の営業・到着時の営業・空席を保証しません。未確認と明示してください。',
        '各候補には店名・営業時間の掲載文・予算・設備が含まれ、そのままrespondのproposeで提案できます。',
      ].join('\n'),
      inputSchema: searchPlacesToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('search_places', input, dependencies, invocationOf(options)),
    }),
    get_place_details: tool<DetailsToolEnvelope, DetailsToolResult>({
      description: [
        '登録済み候補の要求したfieldsだけを取り直します。未対応のfieldは推測せず未対応として扱ってください。',
        '検索結果だけで提案できるので通常は不要です。項目が古くなった（stale）ときの取り直しなど、必要な場合だけ使ってください。',
        '複数の候補はrequests配列で1回にまとめます。読み取りと確定は同じstepにできません。',
        '取得できなかったfieldは未取得として扱い、そのまま提案を続けてください。写真や価格が無い店舗でも提案できます。',
      ].join('\n'),
      inputSchema: getPlaceDetailsToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('get_place_details', input, dependencies, invocationOf(options)),
    }),
    respond: tool<RespondToolEnvelope, RespondToolResult>({
      description: [
        'ターンの応答を1回だけ確定します。kindは次の3つで、同じ重みで選んでください。',
        'ask: 場所や選択に不可欠な希望が足りないとき、質問を原則1つ返します。表示中のカードは維持されます。',
        'answer: 説明・比較・候補が見つからなかった報告・予算が尽きたときの状況説明を返します。表示中のカードは維持されます。',
        'propose: 候補カードをhero1件とalts0〜2件で提案し、messageを1〜4件付けます。各カードにはcandidateIdと理由(why)、別案には比較(diff)を書いてください。カードの店名・営業時間・価格・写真・設備は取得済みの情報からシステムが付けます。',
        '検索で得た候補はそのまま提案できます。店名か営業時間が古くなった候補は確定できないので、get_place_detailsで取り直してください。読み取りと確定は同じstepにできません。',
      ].join('\n'),
      inputSchema: respondToolSchema,
      execute: (input, options) =>
        invokePublicToolEnvelope('respond', input, dependencies, invocationOf(options)),
    }),
  }) satisfies PublicToolSet;

export { isPublicToolName } from '@worker/runtime/ports/tool-binding';

export const getPublicTool = (
  tools: PublicToolSet,
  name: string,
): PublicToolSet[PublicToolName] | undefined => (isPublicToolName(name) ? tools[name] : undefined);
