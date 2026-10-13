const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const requestBody = async (request: Request, maxBodyBytes: number): Promise<Uint8Array> => {
  const body = request.clone().body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBodyBytes) throw new Error('APP_ATTEST_BODY_TOO_LARGE');
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

export const appIntegrityRequestHash = async (
  request: Request,
  maxBodyBytes: number,
  rawBody?: Uint8Array,
): Promise<string> => {
  const body = rawBody ?? (await requestBody(request, maxBodyBytes));
  if (body.byteLength > maxBodyBytes) throw new Error('APP_ATTEST_BODY_TOO_LARGE');
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  const prefix = new TextEncoder().encode(`${request.method}\n${path}\n`);
  const input = new Uint8Array(prefix.byteLength + body.byteLength);
  input.set(prefix);
  input.set(body, prefix.byteLength);
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
};
