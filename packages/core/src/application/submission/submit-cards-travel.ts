import {
  LastTrainInfoSchema,
  OpeningHoursSchema,
  WalkingRouteSchema,
  type LastTrainInfo,
  type WalkingRoute,
} from '../../domain/place-values';
import {
  issue,
  parseObservationValue,
  type KnownObservationField,
  type ResolvedObservation,
  type SubmitValidationContext,
  type SubmitValidationIssue,
} from './submit-cards-evidence';
import { minimumStayIssue, openIntervalAt } from './submit-cards-stay';
import { recalculateLastTrainAtArrival } from '../last-train-recalculation';

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

type ArrivalResult = {
  arrivalAt?: string;
  issue?: SubmitValidationIssue;
};

const arrivalFromRoute = (
  candidateId: string,
  selectionPath: string,
  context: SubmitValidationContext,
  route: WalkingRoute,
  observationId: string,
): ArrivalResult => {
  const departureAt = Date.parse(context.departureAt);
  const maxDurationSeconds = Math.floor((MAX_DATE_MILLISECONDS - departureAt) / 1000);
  if (route.durationSeconds > maxDurationSeconds) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        `${selectionPath}.walkingRoute`,
        'walking duration cannot produce a representable arrival timestamp',
        ['durationSeconds'],
        candidateId,
        [observationId],
      ),
    };
  }
  const arrivalMilliseconds = departureAt + route.durationSeconds * 1000;
  if (
    !Number.isSafeInteger(arrivalMilliseconds) ||
    arrivalMilliseconds < -MAX_DATE_MILLISECONDS ||
    arrivalMilliseconds > MAX_DATE_MILLISECONDS
  ) {
    return {
      issue: issue(
        'INVALID_EVIDENCE',
        `${selectionPath}.walkingRoute`,
        'walking duration produced an invalid arrival timestamp',
        ['durationSeconds'],
        candidateId,
        [observationId],
      ),
    };
  }
  return { arrivalAt: new Date(arrivalMilliseconds).toISOString() };
};

export const validateArrivalAndOpening = (
  candidateId: string,
  selectionPath: string,
  context: SubmitValidationContext,
  observations: Map<KnownObservationField, ResolvedObservation>,
): SubmitValidationIssue[] => {
  const issues: SubmitValidationIssue[] = [];
  let arrivalAt: string | undefined = context.serverNow;
  const walking = observations.get('walking_route');
  if (walking === undefined) {
    if (context.preferences.maxWalkMinutes !== null) {
      issues.push(
        issue(
          'MISSING_EVIDENCE',
          `${selectionPath}.walkingRoute`,
          'walking evidence is required for the explicit walking limit',
          ['walking_route'],
          candidateId,
        ),
      );
    }
  } else {
    const route = parseObservationValue(walking.observation, WalkingRouteSchema);
    if (route === undefined) {
      issues.push(
        issue(
          'INVALID_EVIDENCE',
          `${selectionPath}.evidenceIds`,
          'walking observation value is invalid',
          ['walking_route'],
          candidateId,
        ),
      );
      arrivalAt = undefined;
    } else {
      const expectedOrigin = context.expectedObservationContext.originRef;
      if (
        expectedOrigin === null ||
        route.originRef !== expectedOrigin ||
        route.originRevision !== context.expectedObservationContext.locationRevision ||
        route.destinationCandidateId !== candidateId
      ) {
        issues.push(
          issue(
            'INVALID_EVIDENCE',
            `${selectionPath}.walkingRoute`,
            'walking evidence does not match the current origin or candidate',
            ['originRef', 'originRevision'],
            candidateId,
            [walking.observation.observationId],
          ),
        );
      }
      const computed = arrivalFromRoute(
        candidateId,
        selectionPath,
        context,
        route,
        walking.observation.observationId,
      );
      if (computed.issue !== undefined) {
        issues.push(computed.issue);
        arrivalAt = undefined;
      } else if (computed.arrivalAt !== undefined) {
        arrivalAt = computed.arrivalAt;
      }
      if (
        context.preferences.maxWalkMinutes !== null &&
        route.durationSeconds > context.preferences.maxWalkMinutes * 60
      ) {
        issues.push(
          issue(
            'CONSTRAINT_VIOLATION',
            `${selectionPath}.walkingRoute`,
            'walking duration exceeds the Harness limit',
            ['maxWalkMinutes'],
            candidateId,
            [walking.observation.observationId],
          ),
        );
      }
    }
  }
  const opening = observations.get('opening_hours');
  if (opening === undefined) {
    issues.push(
      issue(
        'MISSING_EVIDENCE',
        `${selectionPath}.openingHours`,
        'opening-hours evidence is required for a current candidate',
        ['opening_hours'],
        candidateId,
      ),
    );
  } else {
    const hours = parseObservationValue(opening.observation, OpeningHoursSchema);
    if (hours === undefined) {
      issues.push(
        issue(
          'CONSTRAINT_VIOLATION',
          `${selectionPath}.openingHours`,
          'opening status is not confirmed by the observation',
          ['opening_hours'],
          candidateId,
          [opening.observation.observationId],
        ),
      );
    } else {
      if (hours.listedOpenAtEvaluation !== true) {
        issues.push(
          issue(
            'CONSTRAINT_VIOLATION',
            `${selectionPath}.openingHours`,
            'opening observation was not listed as open at evaluation',
            ['listedOpenAtEvaluation'],
            candidateId,
            [opening.observation.observationId],
          ),
        );
      }
      if (openIntervalAt(hours, context.serverNow) === undefined) {
        issues.push(
          issue(
            'CONSTRAINT_VIOLATION',
            `${selectionPath}.openingHours`,
            'candidate is not open at the current server time',
            ['opening_hours'],
            candidateId,
            [opening.observation.observationId],
          ),
        );
      }
      if (arrivalAt !== undefined && openIntervalAt(hours, arrivalAt) === undefined) {
        issues.push(
          issue(
            'CONSTRAINT_VIOLATION',
            `${selectionPath}.openingHours`,
            'candidate is not open at the computed arrival',
            ['opening_hours'],
            candidateId,
            [opening.observation.observationId],
          ),
        );
      }
      if (context.requireLastOrderAtArrival) {
        if (hours.lastOrderAt === null || arrivalAt === undefined) {
          issues.push(
            issue(
              'MISSING_EVIDENCE',
              `${selectionPath}.lastOrder`,
              'last-order time is required but unavailable',
              ['lastOrderAt'],
              candidateId,
              [opening.observation.observationId],
            ),
          );
        } else if (Date.parse(arrivalAt) > Date.parse(hours.lastOrderAt)) {
          issues.push(
            issue(
              'CONSTRAINT_VIOLATION',
              `${selectionPath}.lastOrder`,
              'arrival is after last order',
              ['lastOrderAt'],
              candidateId,
              [opening.observation.observationId],
            ),
          );
        }
      }
    }
  }
  return issues;
};

export const validateLastTrain = (
  candidateId: string,
  selectionPath: string,
  context: SubmitValidationContext,
  observations: Map<KnownObservationField, ResolvedObservation>,
): { info: LastTrainInfo | null; issues: SubmitValidationIssue[] } => {
  const homeStationRef = context.preferences.homeStationRef;
  const requiresLastTrain = homeStationRef !== null;
  const observation = observations.get('last_train');
  const info =
    observation === undefined
      ? null
      : (parseObservationValue(observation.observation, LastTrainInfoSchema) ?? null);
  if (!requiresLastTrain) {
    if (context.preferences.minimumStayMinutes === null) {
      return { info, issues: [] };
    }
    const walking = observations.get('walking_route');
    if (walking === undefined) {
      return {
        info,
        issues: [
          issue(
            'MISSING_EVIDENCE',
            `${selectionPath}.walkingRoute`,
            'walking evidence is required to evaluate minimum stay',
            ['walking_route'],
            candidateId,
          ),
        ],
      };
    }
    const route = parseObservationValue(walking.observation, WalkingRouteSchema);
    if (route === undefined) {
      return {
        info,
        issues: [
          issue(
            'INVALID_EVIDENCE',
            `${selectionPath}.walkingRoute`,
            'walking observation value is invalid',
            ['walking_route'],
            candidateId,
            [walking.observation.observationId],
          ),
        ],
      };
    }
    const arrival = arrivalFromRoute(
      candidateId,
      selectionPath,
      context,
      route,
      walking.observation.observationId,
    );
    if (arrival.issue !== undefined || arrival.arrivalAt === undefined) {
      return {
        info,
        issues: [
          arrival.issue ??
            issue(
              'INVALID_EVIDENCE',
              `${selectionPath}.walkingRoute`,
              'walking arrival could not be computed',
              ['durationSeconds'],
              candidateId,
              [walking.observation.observationId],
            ),
        ],
      };
    }
    const stayIssue = minimumStayIssue(
      candidateId,
      selectionPath,
      observations,
      arrival.arrivalAt,
      context.preferences.minimumStayMinutes,
    );
    return {
      info,
      issues: stayIssue === undefined ? [] : [stayIssue],
    };
  }
  const travel = context.travel.find((item) => item.candidateId === candidateId);
  if (observation === undefined || travel === undefined) {
    return {
      info: null,
      issues: [
        issue(
          'MISSING_EVIDENCE',
          `${selectionPath}.lastTrain`,
          'last-train evidence and candidate travel context are required',
          ['last_train', 'homeStationRef', 'serviceDate', 'fromStationRef'],
          candidateId,
        ),
      ],
    };
  }
  const walking = observations.get('walking_route');
  if (walking === undefined) {
    return {
      info: null,
      issues: [
        issue(
          'MISSING_EVIDENCE',
          `${selectionPath}.walkingRoute`,
          'walking evidence is required when a home-station constraint is active',
          ['walking_route'],
          candidateId,
        ),
      ],
    };
  }
  const route = parseObservationValue(walking.observation, WalkingRouteSchema);
  if (route === undefined) {
    return {
      info: null,
      issues: [
        issue(
          'INVALID_EVIDENCE',
          `${selectionPath}.walkingRoute`,
          'walking observation value is invalid',
          ['walking_route'],
          candidateId,
          [walking.observation.observationId],
        ),
      ],
    };
  }
  const arrival = arrivalFromRoute(
    candidateId,
    selectionPath,
    context,
    route,
    walking.observation.observationId,
  );
  if (arrival.issue !== undefined || arrival.arrivalAt === undefined) {
    return {
      info: null,
      issues: [
        arrival.issue ??
          issue(
            'INVALID_EVIDENCE',
            `${selectionPath}.walkingRoute`,
            'walking arrival could not be computed',
            ['durationSeconds'],
            candidateId,
            [walking.observation.observationId],
          ),
      ],
    };
  }
  if (info === null) {
    return {
      info: null,
      issues: [
        issue(
          'INVALID_EVIDENCE',
          `${selectionPath}.lastTrain`,
          'last-train observation value is invalid',
          ['last_train'],
          candidateId,
          [observation.observation.observationId],
        ),
      ],
    };
  }
  const evaluatedArrival = arrivalFromRoute(
    candidateId,
    selectionPath,
    { ...context, departureAt: route.evaluatedAt },
    route,
    walking.observation.observationId,
  );
  if (evaluatedArrival.issue !== undefined || evaluatedArrival.arrivalAt === undefined) {
    return {
      info,
      issues: [
        evaluatedArrival.issue ??
          issue(
            'INVALID_EVIDENCE',
            `${selectionPath}.walkingRoute`,
            'walking observation arrival could not be computed',
            ['durationSeconds'],
            candidateId,
            [walking.observation.observationId],
          ),
      ],
    };
  }
  const matchesContext =
    info.serviceDate === travel.serviceDate &&
    info.fromStationRef === travel.fromStationRef &&
    info.homeStationRef === homeStationRef &&
    (context.preferences.minimumStayMinutes === null ||
      info.minimumStayMinutes === context.preferences.minimumStayMinutes);
  const requiredStayMinutes = context.preferences.minimumStayMinutes ?? info.minimumStayMinutes;
  const recalculated = recalculateLastTrainAtArrival({
    info,
    arrivalAt: arrival.arrivalAt,
    earliestStoredArrivalAt: evaluatedArrival.arrivalAt,
    minimumStayMinutes: requiredStayMinutes,
  });
  if (recalculated.status === 'error') {
    return {
      info,
      issues: [
        issue(
          'INVALID_EVIDENCE',
          `${selectionPath}.${recalculated.error.path ?? 'last_train'}`,
          recalculated.error.message,
          recalculated.error.missingFields,
          candidateId,
          [observation.observation.observationId],
        ),
      ],
    };
  }
  const currentInfo = recalculated.data;
  const minimumStayConstraint = minimumStayIssue(
    candidateId,
    selectionPath,
    observations,
    arrival.arrivalAt,
    requiredStayMinutes,
    currentInfo.leaveBy,
  );
  const requiredStaySeconds = requiredStayMinutes * 60;
  const feasible =
    currentInfo.usable &&
    currentInfo.availableStaySeconds >= requiredStaySeconds &&
    minimumStayConstraint === undefined;
  if (!matchesContext || !feasible) {
    return {
      info: currentInfo,
      issues: [
        issue(
          'CONSTRAINT_VIOLATION',
          `${selectionPath}.lastTrain`,
          'last-train journey does not satisfy the current travel constraints',
          ['last_train', 'homeStationRef', 'serviceDate', 'fromStationRef'],
          candidateId,
          [observation.observation.observationId],
        ),
      ],
    };
  }
  return { info: currentInfo, issues: [] };
};
