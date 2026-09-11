import { SafeAreaProvider } from 'react-native-safe-area-context';
import { JourneyScreen } from './src/screens/JourneyScreen';
import { useNativeMobileRuntime } from './src/hooks/useNativeMobileRuntime';
import { useNativeJourneyPersistence } from './src/hooks/useNativeJourneyPersistence';
import {
  nativeMobileRuntimeMessage,
  type NativeMobileRuntimeOptions,
} from './src/services/api/native-mobile-runtime';
import type { JourneyApiControllerBinding } from './src/services/api/journey-api-binding';

export type AppProps = {
  /** The host supplies fixture/live credentials and request fields at this boundary. */
  readonly journeyApi?: JourneyApiControllerBinding;
  /** Optional formal SQLite/reference policy injection for the same runtime API client. */
  readonly mobileRuntimeOptions?: NativeMobileRuntimeOptions;
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
  const nativeRuntime = useNativeMobileRuntime({
    ...(journeyApi === undefined ? {} : { journeyApi }),
    ...(mobileRuntimeOptions === undefined ? {} : { mobileRuntimeOptions }),
  });
  const persistence = useNativeJourneyPersistence({
    runtime: nativeRuntime.runtime,
    ...(mobileRuntimeOptions?.now === undefined ? {} : { now: mobileRuntimeOptions.now }),
  });
  if (nativeRuntime.binding !== null) {
    return (
      <JourneyScreen
        api={nativeRuntime.binding}
        history={persistence.history}
        historyUnavailable={persistence.historyUnavailable}
        {...(persistence.preferences === undefined ? {} : { preferences: persistence.preferences })}
      />
    );
  }
  if (nativeRuntime.status === 'loading') {
    return <JourneyScreen requestStatus="pending" errorMessage="接続を準備しています。" />;
  }
  return (
    <JourneyScreen
      requestStatus="error"
      errorMessage={
        nativeMobileRuntimeMessage(nativeRuntime.reason) ??
        '検索を開始できません。アプリ設定を確認してください。'
      }
    />
  );
}
