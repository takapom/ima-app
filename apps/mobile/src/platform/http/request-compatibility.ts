import type {
  ConversationTurnRequest,
  Preferences,
  PrefsWriteRequest,
  SearchRequest,
  ThreadTurnRequest,
} from '@ima/contracts';

// Keep the app-first rollout compatible with Workers from before #54/#55. These placeholders
// belong only to the wire format; current schemas discard the retired preference fields.
const compatiblePreferences = (prefs: Preferences) => ({
  ...prefs,
  homeStationRef: null,
  maxWalkMinutes: null,
  minimumStayMinutes: null,
});

/** Apply after input validation, which removes legacy preference keys. */
export const compatibleTurnBody = (
  input: SearchRequest | ThreadTurnRequest | ConversationTurnRequest,
) => ({
  ...input,
  prefs: compatiblePreferences(input.prefs),
  savedPlaceRefs: [],
});

export const compatiblePrefsBody = (input: PrefsWriteRequest) => ({
  ...input,
  prefs: compatiblePreferences(input.prefs),
});
