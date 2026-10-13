/** An explicit, local-install-only staging exception; production remains attested. */
export type PersonalPreviewEnv = {
  readonly IMA_ENV?: string;
  readonly IMA_PERSONAL_PREVIEW?: string;
  readonly APP_TOKEN?: string;
};

export const personalPreviewEnabled = (env: PersonalPreviewEnv): boolean =>
  env.IMA_ENV === 'staging' &&
  env.IMA_PERSONAL_PREVIEW === 'true' &&
  /^[a-f0-9]{64}$/u.test(env.APP_TOKEN ?? '');
