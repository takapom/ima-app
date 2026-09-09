import * as v from 'valibot';
import { IsoTimestampSchema, type RetentionMetadata } from '@ima/core';
import type { RetentionPolicy } from './retention-runtime-contract';

function minimumExpiry(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

export function plusMinutes(value: string, minutes: number): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('RETENTION_CREATED_AT_INVALID');
  return new Date(parsed + minutes * 60_000).toISOString();
}

export function sessionExpiry(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error('RETENTION_CREATED_AT_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const dateParts = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const sameDay = `${dateParts.year}-${dateParts.month}-${dateParts.day}T05:00:00+09:00`;
  const boundary = new Date(sameDay);
  if (parsed.valueOf() < boundary.valueOf()) return sameDay;
  const next = new Date(boundary.valueOf() + 86_400_000);
  const nextParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(next)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${nextParts.year}-${nextParts.month}-${nextParts.day}T05:00:00+09:00`;
}

export function policyOf(value: string | null): RetentionPolicy {
  if (
    value === 'allow' ||
    value === 'deny' ||
    value === 'unknown' ||
    value === 'failure' ||
    value === 'disconnect'
  ) {
    return value;
  }
  return 'unknown';
}

export function retentionFor(
  policy: RetentionPolicy,
  createdAt: string,
  explicitExpiry: string | null,
): RetentionMetadata {
  const sessionExpiresAt = sessionExpiry(createdAt);
  const allow = policy === 'allow';
  const requestedExpiry =
    explicitExpiry === null
      ? plusMinutes(createdAt, 15)
      : v.parse(IsoTimestampSchema, explicitExpiry);
  const retentionUntil = allow ? minimumExpiry(requestedExpiry, sessionExpiresAt) : null;
  const displayLimit = retentionUntil ?? sessionExpiresAt;
  const displayUntil = allow
    ? minimumExpiry(plusMinutes(createdAt, 10), displayLimit)
    : sessionExpiresAt;
  const freshUntil = allow ? minimumExpiry(plusMinutes(createdAt, 5), displayUntil) : null;
  return {
    retentionDecision: allow ? 'allow' : policy === 'deny' ? 'deny' : 'unknown',
    retentionMode: allow ? 'provider_limited' : 'session_only',
    sessionExpiresAt,
    freshUntil,
    displayUntil,
    retentionUntil,
    deletionScheduledAt: allow ? retentionUntil : null,
    attribution: null,
    restoreMode: allow ? 'full' : 'reference_only',
    policyStatus: allow ? 'available' : 'policy_withheld',
    displayPolicyStatus: allow ? 'available' : 'policy_withheld',
  };
}
