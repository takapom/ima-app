import * as v from 'valibot';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})T/;
const isoOffsetPattern = /([+-])(\d{2}):(\d{2})$/;
const validCalendarDate = (value: string) => {
  const match = isoDatePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  if (daysInMonth === undefined) return false;
  return day <= daysInMonth;
};

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const validIsoOffset = (value: string) => {
  if (value.endsWith('Z')) return true;
  const match = isoOffsetPattern.exec(value);
  if (!match) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return hours < 14 || (hours === 14 && minutes === 0);
};

export const IsoTimestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check(validCalendarDate, 'timestamp contains an invalid calendar date'),
  v.check(validIsoOffset, 'timestamp contains an invalid UTC offset'),
);
export type IsoTimestamp = v.InferOutput<typeof IsoTimestampSchema>;

export const OpaqueIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(idPattern),
);

export const HttpsUrlSchema = v.pipe(
  v.string(),
  v.url(),
  // Keep this check total: malformed external input must yield a parse failure, never throw.
  v.check((value) => /^https:\/\//i.test(value), 'source URL must use https'),
);

export const ThreadIdSchema = OpaqueIdSchema;
export const TurnIdSchema = OpaqueIdSchema;
export const ResponseIdSchema = OpaqueIdSchema;
export const CallIdSchema = OpaqueIdSchema;
export const CandidateIdSchema = OpaqueIdSchema;
export const ObservationIdSchema = OpaqueIdSchema;
export const SearchIdSchema = OpaqueIdSchema;
export const SavedPlaceRefSchema = OpaqueIdSchema;
export const RequestIdSchema = OpaqueIdSchema;

export const RevisionSchema = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
export const SchemaVersionSchema = v.literal('v1');
export const CapabilityVersionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

export const DetailFieldSchema = v.picklist([
  'identity',
  'opening_hours',
  'price',
  'photos',
  'contact',
  'facilities',
  'walking_route',
  'last_train',
]);
export type DetailField = v.InferOutput<typeof DetailFieldSchema>;

export const Text = (maxLength: number) =>
  v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength));

export const NullableText = (maxLength: number) =>
  v.nullable(v.pipe(v.string(), v.maxLength(maxLength)));
