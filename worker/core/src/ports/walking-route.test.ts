import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DirectedWalkingRouteInputSchema } from '@core/ports/walking-route';

const point = (lat: number, lng: number) => ({ lat, lng });

describe('directed walking route contract', () => {
  it('keeps current-to-candidate and candidate-to-station direction explicit', () => {
    const parsed = v.safeParse(DirectedWalkingRouteInputSchema, {
      legs: [
        {
          kind: 'current_to_candidate',
          originRef: 'current',
          originCoordinates: point(35.6595, 139.7005),
          originRevision: 2,
          destinationCandidateId: 'candidate-1',
        },
        {
          kind: 'candidate_to_station',
          originCandidateId: 'candidate-1',
          originRef: 'candidate-1-place',
          destinationStationRef: 'station-1',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects duplicate requested pairs within each directed leg kind', () => {
    const current = {
      kind: 'current_to_candidate' as const,
      originRef: 'current',
      originCoordinates: point(35.6595, 139.7005),
      originRevision: 2,
      destinationCandidateId: 'candidate-1',
    };
    expect(v.safeParse(DirectedWalkingRouteInputSchema, { legs: [current, current] }).success).toBe(
      false,
    );
  });

  it('keeps provider waypoint resolution outside the Core contract', () => {
    const parsed = v.safeParse(DirectedWalkingRouteInputSchema, {
      legs: [
        {
          kind: 'current_to_candidate',
          originRef: 'current',
          originCoordinates: point(35.6595, 139.7005),
          originRevision: 2,
          destinationCandidateId: 'candidate-1',
          destinationCoordinates: point(35.658, 139.7016),
        },
        {
          kind: 'candidate_to_station',
          originCandidateId: 'candidate-1',
          originRef: 'candidate-1-place',
          destinationStationRef: 'station-1',
          originCoordinates: point(35.658, 139.7016),
          destinationCoordinates: point(35.6467, 139.71),
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
