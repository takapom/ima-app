import { useState } from 'react';
import { ConversationJourneyScreen } from '@mobile/journey/ConversationJourneyScreen';
import { EntryFlow } from '@mobile/entry/EntryFlow';
import { chatReadiness } from '@mobile/entry/state/entry-flow';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { JourneyScreen } from '@mobile/journey/JourneyScreen';
import { PersonalPreviewConnection } from '@mobile/composition/PersonalPreviewConnection';
import { useNativeMobileRuntime } from '@mobile/composition/hooks/useNativeMobileRuntime';
import { useNativeJourneyPersistence } from '@mobile/composition/hooks/useNativeJourneyPersistence';
import {
  nativeMobileRuntimeMessage,
  type NativeMobileRuntimeOptions,
} from '@mobile/composition/native-mobile-runtime';
import type { JourneyApiControllerBinding } from '@mobile/journey/services/thread-session/journey-api-binding';

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
      <PersonalPreviewConnection
        bypass={journeyApi !== undefined || mobileRuntimeOptions !== undefined}
      >
        {(personalOptions) => {
          const options = mobileRuntimeOptions ?? personalOptions;
          return (
            <AppContent
              {...(journeyApi === undefined ? {} : { journeyApi })}
              {...(options === undefined ? {} : { mobileRuntimeOptions: options })}
            />
          );
        }}
      </PersonalPreviewConnection>
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
  const [firstQuery, setFirstQuery] = useState<string | null>(null);
  const readiness = chatReadiness({
    connected: nativeRuntime.binding !== null,
    status: nativeRuntime.status,
  });
  // One EntryFlow for every branch, so the splash keeps playing while loading turns into ready.
  return (
    <EntryFlow readiness={readiness} onQuestionsAnswered={setFirstQuery}>
      <JourneyContent
        nativeRuntime={nativeRuntime}
        persistence={persistence}
        firstQuery={firstQuery}
        onFirstQuerySent={() => setFirstQuery(null)}
      />
    </EntryFlow>
  );
}

type JourneyContentProps = {
  readonly nativeRuntime: ReturnType<typeof useNativeMobileRuntime>;
  readonly persistence: ReturnType<typeof useNativeJourneyPersistence>;
  /** The question answers, sent once as the first message and then cleared. */
  readonly firstQuery: string | null;
  readonly onFirstQuerySent: () => void;
};

function JourneyContent({
  nativeRuntime,
  persistence,
  firstQuery,
  onFirstQuerySent,
}: JourneyContentProps): React.JSX.Element {
  const initialQuery =
    firstQuery === null ? {} : { initialQuery: firstQuery, onInitialQuerySent: onFirstQuerySent };
  if (nativeRuntime.binding?.conversations !== undefined) {
    return (
      <ConversationJourneyScreen
        binding={{ ...nativeRuntime.binding, conversations: nativeRuntime.binding.conversations }}
        {...(persistence.preferences === undefined ? {} : { preferences: persistence.preferences })}
        {...initialQuery}
      />
    );
  }
  if (nativeRuntime.binding !== null) {
    return (
      <JourneyScreen
        api={nativeRuntime.binding}
        history={persistence.history}
        historyUnavailable={persistence.historyUnavailable}
        {...(persistence.preferences === undefined ? {} : { preferences: persistence.preferences })}
        {...initialQuery}
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
