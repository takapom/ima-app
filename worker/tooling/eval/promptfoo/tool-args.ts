/**
 * 記録したTool引数の読み方。出力の表示と判定で同じ読み方を使うため、ここだけに置く。
 * 引数を`{"input":{...}}`で包むかどうかに関係なく、中身を同じ形で読む。
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toolInputOf = (args: unknown): Record<string, unknown> | undefined => {
  const input = isRecord(args) && isRecord(args.input) ? args.input : args;
  return isRecord(input) ? input : undefined;
};

export type SearchArea =
  | { readonly kind: 'current_location'; readonly radiusMeters: number | null }
  | { readonly kind: 'named_area'; readonly name: string | null }
  | { readonly kind: 'unknown' };

/** `search_places`の引数が指す場所。読めなければ`unknown`。 */
export const searchAreaOf = (args: unknown): SearchArea => {
  const area = toolInputOf(args)?.area;
  if (!isRecord(area)) return { kind: 'unknown' };
  if (area.kind === 'current_location') {
    return {
      kind: 'current_location',
      radiusMeters: typeof area.radiusMeters === 'number' ? area.radiusMeters : null,
    };
  }
  if (area.kind === 'named_area') {
    return { kind: 'named_area', name: typeof area.name === 'string' ? area.name : null };
  }
  return { kind: 'unknown' };
};

/** `search_places`の検索語。無ければnull。 */
export const searchQueryOf = (args: unknown): string | null => {
  const query = toolInputOf(args)?.query;
  return typeof query === 'string' ? query : null;
};
