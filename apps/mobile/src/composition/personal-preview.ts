import { nativeCredentialScopeFor } from '@mobile/platform/credentials/native-credentials';
import type { PersonalConnectionTarget } from '@mobile/platform/credentials/personal-connection';

export type PersonalPreviewConfiguration =
  | { readonly kind: 'disabled' | 'invalid' }
  | { readonly kind: 'enabled'; readonly target: PersonalConnectionTarget };

export const personalPreviewConfiguration = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): PersonalPreviewConfiguration => {
  if (env.EXPO_PUBLIC_PERSONAL_PREVIEW !== 'true') return { kind: 'disabled' };
  if (
    platform !== 'ios' ||
    env.EXPO_PUBLIC_ENVIRONMENT !== 'staging' ||
    env.EXPO_PUBLIC_API_MODE !== 'live'
  ) {
    return { kind: 'invalid' };
  }
  const target: PersonalConnectionTarget = {
    environment: 'staging',
    apiBaseUrl: env.EXPO_PUBLIC_API_BASE_URL ?? '',
  };
  return nativeCredentialScopeFor({ ...target, storageScope: 'personal' }) === null
    ? { kind: 'invalid' }
    : { kind: 'enabled', target };
};
