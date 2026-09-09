import { AgentSessionProvider, Session } from 'agents/experimental/memory/session';
import type {
  SessionMessage,
  SqlProvider,
  StoredCompaction,
} from 'agents/experimental/memory/session';
import { DENIED_MARKER } from './think-gate-provider';

export const PERSISTENCE_MARKER = DENIED_MARKER;

type SqlCursor = { toArray(): readonly Record<string, unknown>[] };
type SqlReader = { exec(query: string): SqlCursor };

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(PERSISTENCE_MARKER, '[redacted]');
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactValue(child)]),
    );
  }
  return value;
}

function redactMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const redacted = { ...part };
      if (redacted.text !== undefined) redacted.text = redactString(redacted.text);
      if (redacted.reasoning !== undefined) {
        redacted.reasoning = redactString(redacted.reasoning);
      }
      if (redacted.toolCallId !== undefined) {
        redacted.toolCallId = redactString(redacted.toolCallId);
      }
      if (redacted.toolName !== undefined) redacted.toolName = redactString(redacted.toolName);
      if (redacted.input !== undefined) redacted.input = redactValue(redacted.input);
      if (redacted.output !== undefined) redacted.output = redactValue(redacted.output);
      if (redacted.state !== undefined) redacted.state = redactString(redacted.state);
      if (redacted.result !== undefined) redacted.result = redactValue(redacted.result);
      return redacted;
    }),
  };
}

function redactString(value: string): string {
  return value.replaceAll(PERSISTENCE_MARKER, '[redacted]');
}

/** Fixture-only write policy; it demonstrates the public provider boundary. */
class RedactingSessionProvider extends AgentSessionProvider {
  override appendMessage(message: SessionMessage, parentId?: string | null): void {
    super.appendMessage(redactMessage(message), parentId);
  }

  override updateMessage(message: SessionMessage): void {
    super.updateMessage(redactMessage(message));
  }

  override addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string,
  ): StoredCompaction {
    return super.addCompaction(redactString(summary), fromMessageId, toMessageId);
  }
}

/** Public SessionProvider policy used by the persistence canary. */
export function sessionWithPersistencePolicy(agent: SqlProvider): Session {
  return Session.create(new RedactingSessionProvider(agent));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function hasMarker(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(PERSISTENCE_MARKER);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => hasMarker(child, seen));
}

export type MarkerTableObservation = {
  observed: boolean;
  readError: string | null;
  count: number;
};

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Return marker observations only; never expose provider text in the report. */
export function markerRowsByTable(sql: SqlReader): Record<string, MarkerTableObservation> {
  const observations: Record<string, MarkerTableObservation> = {};
  let tables: readonly Record<string, unknown>[];
  try {
    tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .toArray();
  } catch (error) {
    observations.sqlite_master = { observed: false, readError: readError(error), count: 0 };
    return observations;
  }

  for (const row of tables) {
    const name = row.name;
    if (typeof name !== 'string') continue;
    try {
      const rows = sql.exec(`SELECT * FROM ${quoteIdentifier(name)}`).toArray();
      observations[name] = {
        observed: true,
        readError: null,
        count: rows.filter((candidate) => hasMarker(candidate)).length,
      };
    } catch (error) {
      observations[name] = { observed: false, readError: readError(error), count: 0 };
    }
  }
  return observations;
}
