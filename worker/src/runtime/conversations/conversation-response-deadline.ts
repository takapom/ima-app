/** Earliest deadline of every retention envelope in an already validated public DTO. */
export const conversationResponseDeadline = (value: unknown, now: number): number => {
  let deadline = now + 60_000;
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (
        ['sessionExpiresAt', 'displayUntil', 'retentionUntil', 'deletionScheduledAt'].includes(
          key,
        ) &&
        typeof child === 'string'
      ) {
        const parsed = Date.parse(child);
        deadline = Number.isFinite(parsed) ? Math.min(deadline, parsed) : now;
      } else visit(child);
    }
  };
  visit(value);
  return deadline;
};
