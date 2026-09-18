const encodeHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Binds a create idempotency key to its authenticated owner without exposing either value.
 * A retry therefore addresses the same Durable Object, while another owner gets another ID.
 */
export const createThreadId = async (
  ownerScopeRef: string,
  idempotencyKey: string,
): Promise<string> => {
  const value = `${ownerScopeRef}\u0000${idempotencyKey}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `thread-create-v1-${encodeHex(new Uint8Array(digest))}`;
};
