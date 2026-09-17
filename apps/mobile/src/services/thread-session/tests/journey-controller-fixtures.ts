import type { PublicMessage } from '@ima/contracts';

export const message = {
  text: '候補を確認しました',
  evidenceIds: [],
  evidence: [],
  basis: 'conversational',
  retention: {
    retentionDecision: 'deny',
    retentionMode: 'session_only',
    sessionExpiresAt: '2026-09-10T13:00:00Z',
    freshUntil: '2026-09-10T13:00:00Z',
    displayUntil: '2026-09-10T13:00:00Z',
    retentionUntil: null,
    deletionScheduledAt: null,
    attribution: null,
    restoreMode: 'reference_only',
    policyStatus: 'policy_withheld',
    displayPolicyStatus: 'available',
  },
} as PublicMessage;
