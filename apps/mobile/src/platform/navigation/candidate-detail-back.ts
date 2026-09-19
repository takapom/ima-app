import { BackHandler, Platform } from 'react-native';

/** BackHandler is Android-only; the effect owns this subscription's lifetime. */
export const subscribeCandidateDetailBack = (close: () => void): (() => void) | undefined => {
  if (Platform.OS !== 'android') return undefined;
  const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
    close();
    return true;
  });
  return () => subscription.remove();
};
