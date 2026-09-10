import { useMemo } from 'react';
import { JourneyScreen } from './src/screens/JourneyScreen';
import {
  createMobileJourneyRuntime,
  mobileJourneyRuntimeMessage,
} from './src/services/api/mobile-runtime';
import type { JourneyApiControllerBinding } from './src/services/api/journey-api-binding';

export type AppProps = {
  /** The host supplies fixture/live credentials and request fields at this boundary. */
  readonly journeyApi?: JourneyApiControllerBinding;
  readonly [key: string]: unknown;
};

export default function App({ journeyApi }: AppProps): React.JSX.Element {
  const runtime = useMemo(() => createMobileJourneyRuntime(), []);
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
