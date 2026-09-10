import * as v from 'valibot';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const RouteRedirectProbeSchema = v.strictObject({
  code: v.literal('INVALID_REQUEST'),
  redirect: v.literal('manual'),
  status: v.literal(302),
});

describe('runtime-native Routes transport', () => {
  it('uses manual redirect handling and rejects a 3xx response in a real Worker', async () => {
    const response = await SELF.fetch('https://ima.test/__runtime-native/routes-redirect-probe');
    expect(response.status).toBe(200);
    const parsed = v.safeParse(RouteRedirectProbeSchema, await response.json());
    expect(parsed.success).toBe(true);
  });
});
