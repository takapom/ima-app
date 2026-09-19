import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSourceLinkOperationGate,
  openJourneySourceLink,
  type JourneySourceLinkService,
  type SourceLinkOpenResult,
} from '@mobile/journey/services/journey-source-link';

export type JourneySourceLinkNotice = {
  readonly tone: 'info' | 'success' | 'error';
  readonly text: string;
};

type UseJourneySourceLinkOptions = {
  readonly contextKey: string;
  readonly service: JourneySourceLinkService;
};

const noticeFor = (result: SourceLinkOpenResult): JourneySourceLinkNotice => {
  if (result.status === 'opened') return { tone: 'success', text: '出典を開きました。' };
  if (result.status === 'unavailable') {
    return { tone: 'error', text: 'この出典リンクは開けません。' };
  }
  return { tone: 'error', text: '出典リンクを開けませんでした。' };
};

export const useJourneySourceLink = ({
  contextKey,
  service,
}: UseJourneySourceLinkOptions): {
  readonly notice: JourneySourceLinkNotice | null;
  readonly open: (sourceLink: string) => void;
  readonly clear: () => void;
} => {
  const [notice, setNotice] = useState<JourneySourceLinkNotice | null>(null);
  const mounted = useRef(false);
  const gate = useMemo(() => createSourceLinkOperationGate(), []);

  useEffect(() => {
    mounted.current = true;
    gate.setContext(contextKey);
    setNotice(null);
    return () => {
      mounted.current = false;
      gate.invalidate();
    };
  }, [contextKey, gate, service]);

  const open = useCallback(
    (sourceLink: string): void => {
      if (!mounted.current) return;
      const token = gate.begin(contextKey);
      if (token === null) return;
      setNotice({ tone: 'info', text: '出典を開いています…' });
      void openJourneySourceLink(service, sourceLink)
        .then((result) => {
          if (!mounted.current || !gate.accepts(token)) return;
          setNotice(noticeFor(result));
        })
        .catch(() => {
          if (mounted.current && gate.accepts(token)) {
            setNotice({ tone: 'error', text: '出典リンクを開けませんでした。' });
          }
        });
    },
    [contextKey, gate, service],
  );

  const clear = useCallback((): void => {
    gate.invalidate();
    setNotice(null);
  }, [gate]);

  return { notice, open, clear };
};
