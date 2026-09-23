import type { BaseIssue } from 'valibot';

// Only contract field names may survive SDK error redaction, never input values or unknown keys.
const FIELD_NAMES = new Set([
  'input',
  'mode',
  'query',
  'area',
  'kind',
  'name',
  'radiusMeters',
  'limit',
  'excludeCandidateIds',
  'cursor',
  'requests',
  'candidateId',
  'fields',
  'freshness',
  'message',
  'hero',
  'alts',
  'evidenceIds',
  'why',
  'diff',
  'text',
  'basis',
  '$',
  '*',
]);
const PREFIX = 'Tool input validation failed. Invalid fields: ';
const MAX_FIELDS = 8;

export function toolInputValidationError(issues: readonly BaseIssue<unknown>[]): Error {
  const fields = new Set<string>();
  const collect = (items: readonly BaseIssue<unknown>[], parent: readonly string[] = []) => {
    for (const issue of items) {
      if (fields.size >= MAX_FIELDS) return;
      const path = [
        ...parent,
        ...(issue.path?.map(({ key }) =>
          typeof key === 'string' && FIELD_NAMES.has(key) ? key : '*',
        ) ?? []),
      ].slice(0, 8);
      if (issue.issues !== undefined) {
        collect(issue.issues, path);
        continue;
      }
      fields.add(path.join('.') || '$');
    }
  };
  collect(issues);
  return new Error(`${PREFIX}${[...fields].join(', ')}`);
}

/** AI SDK wraps validation errors and may serialize them together with raw arguments. */
export function toolInputInvalidFields(error: unknown): readonly string[] | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const start = message.lastIndexOf(PREFIX);
  if (start === -1) return undefined;
  const fields = message.slice(start + PREFIX.length).split(', ');
  if (
    fields.length > MAX_FIELDS ||
    !fields.every((field) => {
      const parts = field.split('.');
      return parts.length <= 8 && parts.every((part) => FIELD_NAMES.has(part));
    })
  )
    return undefined;
  return fields;
}

export function safeToolInputValidationMessage(error: unknown): string | undefined {
  const fields = toolInputInvalidFields(error);
  return fields === undefined ? undefined : `${PREFIX}${fields.join(', ')}`;
}
