export type SourceLinkUnavailableReason =
  'invalid_url' | 'credentials_in_url' | 'unsupported_scheme' | 'link_unavailable';

export type SourceLinkPreparation =
  | { readonly status: 'ready'; readonly url: string }
  | {
      readonly status: 'unavailable';
      readonly reason: Exclude<SourceLinkUnavailableReason, 'link_unavailable'>;
    };

export type SourceLinkOpenResult =
  | { readonly status: 'opened' }
  | { readonly status: 'unavailable'; readonly reason: SourceLinkUnavailableReason }
  | { readonly status: 'failed'; readonly reason: 'native_unavailable' };

export type JourneySourceLinkService = {
  readonly openSourceLink: (sourceLink: string) => Promise<SourceLinkOpenResult>;
};

/** Action failures take precedence while a source-link notice is still visible. */
export const selectJourneyNoticeText = (
  actionNoticeText: string | null,
  sourceNoticeText: string | null,
): string | null => actionNoticeText ?? sourceNoticeText ?? null;

export type SourceLinkOperationToken = {
  readonly contextKey: string;
  readonly generation: number;
};

export type SourceLinkOperationGate = {
  readonly setContext: (contextKey: string) => void;
  readonly begin: (contextKey: string) => SourceLinkOperationToken | null;
  readonly invalidate: () => void;
  readonly accepts: (token: SourceLinkOperationToken) => boolean;
};

/** Results from an earlier link press must not replace a newer notice. */
export const createSourceLinkOperationGate = (): SourceLinkOperationGate => {
  let activeContextKey: string | null = null;
  let generation = 0;
  return {
    setContext: (contextKey) => {
      activeContextKey = contextKey;
      generation += 1;
    },
    begin: (contextKey) => {
      if (activeContextKey !== contextKey) return null;
      generation += 1;
      return { contextKey, generation };
    },
    invalidate: () => {
      generation += 1;
    },
    accepts: (token) => activeContextKey === token.contextKey && generation === token.generation,
  };
};

export const prepareSourceLink = (sourceLink: string): SourceLinkPreparation => {
  if (sourceLink.length === 0 || sourceLink.trim() !== sourceLink) {
    return { status: 'unavailable', reason: 'invalid_url' };
  }
  let url: URL;
  try {
    url = new URL(sourceLink);
  } catch {
    return { status: 'unavailable', reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { status: 'unavailable', reason: 'unsupported_scheme' };
  }
  if (url.hostname.length === 0) return { status: 'unavailable', reason: 'invalid_url' };
  if (url.username.length > 0 || url.password.length > 0) {
    return { status: 'unavailable', reason: 'credentials_in_url' };
  }
  return { status: 'ready', url: url.toString() };
};

export const openJourneySourceLink = async (
  service: JourneySourceLinkService,
  sourceLink: string,
): Promise<SourceLinkOpenResult> => {
  const prepared = prepareSourceLink(sourceLink);
  if (prepared.status !== 'ready') return prepared;
  try {
    return await service.openSourceLink(prepared.url);
  } catch {
    return { status: 'failed', reason: 'native_unavailable' };
  }
};
