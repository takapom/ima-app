import * as v from 'valibot';
import type { SearchOutcome } from '@ima/contracts';

type TurnToolResult = {
  readonly toolName: string;
  readonly output: unknown;
};

const SuccessfulSearchSchema = v.object({
  status: v.literal('ok'),
  data: v.object({ candidates: v.array(v.unknown()) }),
});

/**
 * A fact about the turn's searches, not about the model's reply: every search_places call ran
 * successfully and none returned a candidate. A failed, partial or unreadable search keeps it
 * unknown, so failures are never reported as "nothing found".
 */
export function searchOutcomeOf(results: Iterable<TurnToolResult>): SearchOutcome | undefined {
  let searched = false;
  for (const result of results) {
    if (result.toolName !== 'search_places') continue;
    const parsed = v.safeParse(SuccessfulSearchSchema, result.output);
    if (!parsed.success || parsed.output.data.candidates.length > 0) return undefined;
    searched = true;
  }
  return searched ? 'no_candidates' : undefined;
}
