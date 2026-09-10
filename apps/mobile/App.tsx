import { useMemo } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { JourneyScreen } from './src/screens/JourneyScreen';
import {
  createMobileJourneyRuntime,
  mobileJourneyRuntimeMessage,
  type MobileJourneyRuntimeOptions,
} from './src/services/api/mobile-runtime';
import type { JourneyApiControllerBinding } from './src/services/api/journey-api-binding';

export type AppProps = {
  /** The host supplies fixture/live credentials and request fields at this boundary. */
  readonly journeyApi?: JourneyApiControllerBinding;
  /** Optional formal SQLite/reference policy injection for the same runtime API client. */
  readonly mobileRuntimeOptions?: MobileJourneyRuntimeOptions;
  readonly [key: string]: unknown;
};

export default function App({ journeyApi, mobileRuntimeOptions }: AppProps): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppContent
        {...(journeyApi === undefined ? {} : { journeyApi })}
        {...(mobileRuntimeOptions === undefined ? {} : { mobileRuntimeOptions })}
      />
    </SafeAreaProvider>
  );
}

function AppContent({ journeyApi, mobileRuntimeOptions }: AppProps): React.JSX.Element {
  const runtime = useMemo(
    () => createMobileJourneyRuntime(mobileRuntimeOptions),
    [mobileRuntimeOptions],
  );
  const binding = journeyApi ?? runtime.binding;
  if (binding !== null && binding !== undefined) return <JourneyScreen api={binding} />;
  return (
    <JourneyScreen
      requestStatus="error"
      errorMessage={
        mobileJourneyRuntimeMessage(runtime.reason) ??
        '検索を開始できません。アプリ設定を確認してください。'
      }
    />
  );
}
