import * as v from 'valibot';
import type { SessionMessage } from '@cloudflare/think';
import type { UIMessage } from 'ai';
import {
  RetentionMessageMetadataSchema,
  type RetentionMessageMetadata,
} from '../../support/retention-policy';

const SIDECAR_PREFIX = 'm04:retention:message:';

function sidecarKey(messageId: string): string {
  return `${SIDECAR_PREFIX}${messageId}`;
}

function roleOf(value: string): UIMessage['role'] | undefined {
  return value === 'system' || value === 'user' || value === 'assistant' ? value : undefined;
}

function partToUiPart(part: SessionMessage['parts'][number]): UIMessage['parts'][number] {
  if (part.type === 'text' && typeof part.text === 'string') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'reasoning' && typeof part.reasoning === 'string') {
    return { type: 'reasoning', text: part.reasoning };
  }
  return { type: 'data-retention-observed', data: { source: part } };
}

/** The sidecar contains policy/identity only; it never contains message parts or body text. */
export async function putRetentionSidecar(
  storage: DurableObjectState['storage'],
  messageId: string,
  metadata: RetentionMessageMetadata,
): Promise<void> {
  await storage.put(sidecarKey(messageId), {
    retention: { ...metadata.retention, attribution: null },
    ownerScopeRef: metadata.ownerScopeRef,
    threadId: metadata.threadId,
    turnId: metadata.turnId,
  });
}

export async function getRetentionSidecar(
  storage: DurableObjectState['storage'],
  messageId: string,
): Promise<RetentionMessageMetadata | undefined> {
  const value = await storage.get<unknown>(sidecarKey(messageId));
  if (value === undefined) return undefined;
  const parsed = v.safeParse(RetentionMessageMetadataSchema, value);
  if (!parsed.success) throw new Error('RETENTION_SIDECAR_INVALID');
  return parsed.output;
}

export async function deleteRetentionSidecars(
  storage: DurableObjectState['storage'],
): Promise<void> {
  const entries = await storage.list({ prefix: SIDECAR_PREFIX });
  if (entries.size > 0) await storage.delete([...entries.keys()]);
}

export function sessionMessageToUiMessage(
  message: SessionMessage,
  metadata: RetentionMessageMetadata | undefined,
): UIMessage | undefined {
  const role = roleOf(message.role);
  if (role === undefined) return undefined;
  const parts = message.parts.map(partToUiPart);
  return metadata === undefined
    ? { id: message.id, role, parts }
    : { id: message.id, role, parts, metadata };
}

export async function historyWithRetentionSidecars(
  storage: DurableObjectState['storage'],
  history: readonly SessionMessage[],
): Promise<UIMessage[]> {
  const messages: UIMessage[] = [];
  for (const message of history) {
    const metadata = await getRetentionSidecar(storage, message.id);
    const uiMessage = sessionMessageToUiMessage(message, metadata);
    if (uiMessage !== undefined) messages.push(uiMessage);
  }
  return messages;
}
