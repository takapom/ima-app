import {
  JourneyServiceDateContextSchema,
  type JourneyRecord,
  type JourneyServiceDateContext,
} from '@worker/domain/travel/journey';
import {
  classifyJourneyForServiceDate,
  type JourneyAvailability,
} from '@worker/domain/travel/journey-validation';
import * as v from 'valibot';
import type { JourneyDatasetReader } from '@worker/adapters/out/persistence/last-train/store';
import { parseJourneyDataset } from '@worker/adapters/out/persistence/last-train/types';

export type JourneyReadResult =
  | {
      readonly status: 'known';
      readonly revision: number;
      readonly journeys: readonly JourneyRecord[];
    }
  | {
      readonly status: 'not_applicable';
      readonly revision: number | null;
      readonly availability: Extract<JourneyAvailability, { status: 'not_applicable' }>;
    }
  | {
      readonly status: 'disabled';
      readonly revision: number | null;
      readonly availability: Extract<JourneyAvailability, { status: 'disabled' }>;
    }
  | {
      readonly status: 'error';
      readonly code: 'STORAGE_UNAVAILABLE';
      readonly revision: null;
      readonly message: 'journey dataset storage is unavailable';
    };

type NonKnownJourneyAvailability = Exclude<JourneyAvailability, { readonly status: 'known' }>;

const invalidAvailability = (): NonKnownJourneyAvailability => ({
  status: 'disabled',
  reason: 'invalid',
  issues: [
    {
      code: 'INVALID_EVIDENCE',
      path: 'journey.dataset',
      retryable: false,
      retryAfterMs: null,
      message: 'Core returned a known journey for missing input',
      missingFields: ['journey'],
    },
  ],
  walkingVerificationRequired: true,
});

const withoutKnown = (availability: JourneyAvailability): NonKnownJourneyAvailability =>
  availability.status === 'known' ? invalidAvailability() : availability;

const invalidContext = (context: unknown): JourneyReadResult => ({
  status: 'disabled',
  revision: null,
  availability: {
    status: 'disabled',
    reason: 'invalid',
    issues: [
      {
        code: 'MISSING_CONTEXT',
        path: 'journey.context',
        retryable: false,
        retryAfterMs: null,
        message: 'journey service-date context is invalid',
        missingFields: v.safeParse(JourneyServiceDateContextSchema, context).success
          ? []
          : ['serviceDate', 'weekday', 'now', 'fromStationRef', 'homeStationRef'],
      },
    ],
    walkingVerificationRequired: true,
  },
});

const disabledFrom = (
  revision: number | null,
  availability: NonKnownJourneyAvailability,
): JourneyReadResult => {
  if (availability.status === 'not_applicable') {
    return { status: 'not_applicable', revision, availability };
  }
  return { status: 'disabled', revision, availability };
};

const chooseDisabled = (
  revision: number,
  results: readonly JourneyAvailability[],
): JourneyReadResult => {
  const disabled = results.find(
    (result): result is Extract<JourneyAvailability, { readonly status: 'disabled' }> =>
      result.status === 'disabled',
  );
  if (disabled !== undefined) return disabledFrom(revision, disabled);
  const notApplicable = results.find(
    (result): result is Extract<JourneyAvailability, { readonly status: 'not_applicable' }> =>
      result.status === 'not_applicable',
  );
  if (notApplicable !== undefined) return disabledFrom(revision, notApplicable);
  return disabledFrom(revision, {
    status: 'disabled',
    reason: 'missing',
    issues: [],
    walkingVerificationRequired: true,
  });
};

/** Reads only validated records from the active Worker dataset. */
export const createJourneyReader = (store: JourneyDatasetReader) => ({
  async read(context: JourneyServiceDateContext): Promise<JourneyReadResult> {
    if (!v.safeParse(JourneyServiceDateContextSchema, context).success) {
      return invalidContext(context);
    }
    let raw: unknown;
    try {
      raw = await store.readCurrent();
    } catch {
      return {
        status: 'error',
        code: 'STORAGE_UNAVAILABLE',
        revision: null,
        message: 'journey dataset storage is unavailable',
      };
    }
    if (raw === null) {
      const availability = classifyJourneyForServiceDate(undefined, context);
      return disabledFrom(null, withoutKnown(availability));
    }
    const parsed = parseJourneyDataset(raw);
    if (!parsed.ok) {
      return disabledFrom(null, {
        status: 'disabled',
        reason: 'invalid',
        issues: [
          {
            code: 'INVALID_EVIDENCE',
            path: 'journey.dataset',
            retryable: false,
            retryAfterMs: null,
            message: 'active journey dataset does not satisfy the Core contract',
            missingFields: ['records'],
          },
        ],
        walkingVerificationRequired: true,
      });
    }
    const matching = parsed.dataset.records.filter(
      (record) =>
        record.fromStationRef === context.fromStationRef &&
        record.homeStationRef === context.homeStationRef,
    );
    if (matching.length === 0) {
      return disabledFrom(
        parsed.dataset.revision,
        withoutKnown(classifyJourneyForServiceDate(undefined, context)),
      );
    }
    const availability = matching.map((record) => classifyJourneyForServiceDate(record, context));
    const known = availability.flatMap((result) =>
      result.status === 'known' ? [result.journey] : [],
    );
    if (known.length > 0) {
      return { status: 'known', revision: parsed.dataset.revision, journeys: known };
    }
    return chooseDisabled(parsed.dataset.revision, availability);
  },
});
