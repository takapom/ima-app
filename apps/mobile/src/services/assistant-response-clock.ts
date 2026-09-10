export type AssistantResponseClock = () => string;

export const systemAssistantResponseClock: AssistantResponseClock = () => new Date().toISOString();

export const createMonotonicAssistantResponseClock = (
  source: AssistantResponseClock,
): AssistantResponseClock => {
  let observed: string | null = null;
  return () => {
    const candidate = source();
    if (observed === null || Date.parse(candidate) > Date.parse(observed)) observed = candidate;
    return observed;
  };
};

export const advanceAssistantResponseNow = (current: string, candidate: string): string =>
  Date.parse(candidate) > Date.parse(current) ? candidate : current;

export type ResponseResumeSubscription = (listener: (status: string) => void) => () => void;

export const subscribeToAssistantResponseResume = (
  subscribe: ResponseResumeSubscription,
  refresh: () => void,
): (() => void) => subscribe((status) => (status === 'active' ? refresh() : undefined));
