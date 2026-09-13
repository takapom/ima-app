import * as v from 'valibot';
import { IsoTimestampSchema } from '@ima/core';
import {
  RuntimeRetentionEphemeralScopeSchema,
  RuntimeRetentionScopeIdentitySchema,
} from '../runtime-retention';
import type {
  RuntimeRetentionEphemeralToolCall,
  RuntimeRetentionEphemeralToolResult,
  RuntimeRetentionScopeIdentity,
} from '../runtime-retention';

/**
 * Checks only the model-input lifetime and scope. Display and persistence policy are evaluated
 * independently by their own adapters; they must not prevent an explicitly allowed llm_input.
 */
export function runtimeEphemeralModelInputIsUsable(
  entry: RuntimeRetentionEphemeralToolCall | RuntimeRetentionEphemeralToolResult,
  currentScope: RuntimeRetentionScopeIdentity,
  now: string,
): boolean {
  const parsedEntryScope = v.safeParse(RuntimeRetentionEphemeralScopeSchema, entry.scope);
  const parsedCurrentScope = v.safeParse(RuntimeRetentionScopeIdentitySchema, currentScope);
  const parsedClock = v.safeParse(IsoTimestampSchema, now);
  if (!parsedEntryScope.success || !parsedCurrentScope.success || !parsedClock.success)
    return false;
  const entryScope = parsedEntryScope.output;
  const scopeMatches =
    entryScope.ownerScopeRef === parsedCurrentScope.output.ownerScopeRef &&
    entryScope.threadId === parsedCurrentScope.output.threadId &&
    entryScope.turnId === parsedCurrentScope.output.turnId;
  if (!scopeMatches) return false;
  const nowMs = Date.parse(parsedClock.output);
  const sessionExpiryMs = Date.parse(entryScope.retention.sessionExpiresAt);
  const deletionMs =
    entryScope.retention.deletionScheduledAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(entryScope.retention.deletionScheduledAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(sessionExpiryMs) || nowMs >= sessionExpiryMs) {
    return false;
  }
  if (Number.isNaN(deletionMs) || nowMs >= deletionMs) return false;
  if ('output' in entry) {
    const parsedFreshUntil = v.safeParse(IsoTimestampSchema, entry.localFreshUntil);
    const parsedExpiresAt = v.safeParse(IsoTimestampSchema, entry.localExpiresAt);
    if (!parsedFreshUntil.success || !parsedExpiresAt.success) return false;
    return (
      nowMs < Date.parse(parsedFreshUntil.output) && nowMs < Date.parse(parsedExpiresAt.output)
    );
  }
  return true;
}
