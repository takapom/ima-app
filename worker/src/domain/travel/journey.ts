import * as v from 'valibot';
import { CalendarDateSchema, IsoTimestampSchema, OpaqueIdSchema } from '@worker/domain/primitives';
import { SourceRefSchema } from '@worker/domain/evidence/evidence';
import { LastTrainTransferSchema } from '@worker/domain/places/place-values';

export const JourneyWeekdaySchema = v.picklist([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
export type JourneyWeekday = v.InferOutput<typeof JourneyWeekdaySchema>;

const weekdays: readonly JourneyWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const TOKYO_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;

const nextCalendarDate = (date: string): string => {
  const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(milliseconds + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

/** Derives a weekday from a calendar date without applying the host timezone. */
export const weekdayForCalendarDate = (date: string): JourneyWeekday | undefined => {
  const parsed = v.safeParse(CalendarDateSchema, date);
  if (!parsed.success) return undefined;
  const milliseconds = Date.parse(`${parsed.output}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return undefined;
  return weekdays[new Date(milliseconds).getUTCDay()];
};

const tokyoCalendarDateForTimestamp = (timestamp: string): string =>
  new Date(Date.parse(timestamp) + TOKYO_OFFSET_MILLISECONDS).toISOString().slice(0, 10);

export const JourneyHolidayPolicySchema = v.picklist(['allowed', 'excluded', 'only']);
export type JourneyHolidayPolicy = v.InferOutput<typeof JourneyHolidayPolicySchema>;

export const JourneyServicePatternSchema = v.pipe(
  v.strictObject({
    weekdays: v.pipe(v.array(JourneyWeekdaySchema), v.minLength(1), v.maxLength(7)),
    holidayPolicy: JourneyHolidayPolicySchema,
  }),
  v.check(
    (pattern) => new Set(pattern.weekdays).size === pattern.weekdays.length,
    'journey weekdays must be unique',
  ),
);
export type JourneyServicePattern = v.InferOutput<typeof JourneyServicePatternSchema>;

/** A journey transfer uses the same public transfer contract as LastTrainInfo. */
export const JourneyTransferSchema = LastTrainTransferSchema;
export type JourneyTransfer = v.InferOutput<typeof JourneyTransferSchema>;

export const JourneyRecordSchema = v.pipe(
  v.strictObject({
    journeyRef: OpaqueIdSchema,
    fromStationRef: OpaqueIdSchema,
    homeStationRef: OpaqueIdSchema,
    serviceDate: CalendarDateSchema,
    servicePattern: JourneyServicePatternSchema,
    lastDepartureAt: IsoTimestampSchema,
    arrivesHomeAt: IsoTimestampSchema,
    transfers: v.pipe(v.array(JourneyTransferSchema), v.maxLength(16)),
    validFrom: CalendarDateSchema,
    validThrough: CalendarDateSchema,
    verifiedAt: IsoTimestampSchema,
    source: SourceRefSchema,
  }),
  v.check((journey) => {
    const departure = Date.parse(journey.lastDepartureAt);
    const arrival = Date.parse(journey.arrivesHomeAt);
    const serviceWindow = new Set([journey.serviceDate, nextCalendarDate(journey.serviceDate)]);
    const timestampDates = [
      journey.lastDepartureAt,
      journey.arrivesHomeAt,
      ...journey.transfers.flatMap((transfer) => [transfer.departureAt, transfer.arrivalAt]),
    ].map(tokyoCalendarDateForTimestamp);
    if (
      journey.validFrom > journey.validThrough ||
      departure > arrival ||
      timestampDates.some((date) => !serviceWindow.has(date))
    ) {
      return false;
    }
    if (
      journey.transfers.length > 0 &&
      (journey.transfers[0]?.fromStationRef !== journey.fromStationRef ||
        Date.parse(journey.transfers[0]?.departureAt ?? '') !== departure)
    ) {
      return false;
    }
    let previous = departure;
    let previousStation = journey.fromStationRef;
    for (const transfer of journey.transfers) {
      const transferDeparture = Date.parse(transfer.departureAt);
      const transferArrival = Date.parse(transfer.arrivalAt);
      if (
        transfer.fromStationRef !== previousStation ||
        transferDeparture < previous ||
        transferArrival < transferDeparture
      ) {
        return false;
      }
      previous = transferArrival;
      previousStation = transfer.toStationRef;
    }
    return (
      previous <= arrival &&
      (journey.transfers.length === 0 ||
        (previousStation === journey.homeStationRef && previous === arrival))
    );
  }, 'journey dates and transfer order must be consistent'),
);
export type JourneyRecord = v.InferOutput<typeof JourneyRecordSchema>;

export const JourneyServiceDateContextSchema = v.strictObject({
  serviceDate: CalendarDateSchema,
  weekday: JourneyWeekdaySchema,
  isHoliday: v.boolean(),
  now: IsoTimestampSchema,
  fromStationRef: OpaqueIdSchema,
  homeStationRef: OpaqueIdSchema,
});
export type JourneyServiceDateContext = v.InferOutput<typeof JourneyServiceDateContextSchema>;

export const JOURNEY_VERIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const JOURNEY_EXIT_BUFFER_SECONDS = 180;
