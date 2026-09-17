/** Returns the first 05:00 JST after the supplied server timestamp. */
export const sessionExpiryAt = (serverNow: string): string => {
  const utcMs = Date.parse(serverNow);
  if (!Number.isFinite(utcMs)) throw new Error('RUNTIME_PRODUCTION_CLOCK');
  const jst = new Date(utcMs + 9 * 60 * 60 * 1_000);
  jst.setUTCHours(5, 0, 0, 0);
  if (jst.getTime() <= utcMs + 9 * 60 * 60 * 1_000) {
    jst.setUTCDate(jst.getUTCDate() + 1);
  }
  return new Date(jst.getTime() - 9 * 60 * 60 * 1_000).toISOString();
};
