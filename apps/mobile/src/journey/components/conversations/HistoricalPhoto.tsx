import { useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ConversationPhotoPath } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { usePhotoImage } from '@mobile/journey/hooks/usePhotoImage';
import { isPhotoImageReadyFor } from '@mobile/journey/state/photo-image-state';
import { colors, typography } from '@mobile/ui/theme/tokens';

/** The historical proposal stays untouched; this region displays a current provider photo. */
export function HistoricalPhoto({
  path,
  fetchPhoto,
  active,
}: {
  readonly path: ConversationPhotoPath;
  readonly fetchPhoto: NonNullable<JourneyPhotoClient['fetchConversationPhoto']>;
  readonly active: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.region}>
      {active ? (
        <HistoricalPhotoLoader path={path} fetchPhoto={fetchPhoto} />
      ) : (
        <Text style={styles.text}>店舗写真</Text>
      )}
    </View>
  );
}

function HistoricalPhotoLoader({
  path,
  fetchPhoto,
}: {
  readonly path: ConversationPhotoPath;
  readonly fetchPhoto: NonNullable<JourneyPhotoClient['fetchConversationPhoto']>;
}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const { conversationId, sequence, candidateId } = path;
  const source = useMemo<JourneyPhotoClient>(
    () => ({
      fetchPhoto: (_token, options) =>
        fetchPhoto({ conversationId, sequence, candidateId }, { ...options, refresh: attempt > 0 }),
      // A new client identity gives an explicit retry a fresh request lifecycle.
    }),
    [fetchPhoto, conversationId, sequence, candidateId, attempt],
  );
  const token = `${candidateId}:${attempt}`;
  const photo = usePhotoImage(source, token, null);
  const unavailable = failed || photo.status === 'unavailable' || photo.status === 'expired';
  const missing =
    photo.status === 'unavailable' && photo.error?.kind === 'http' && photo.error.status === 404;
  return (
    <View style={styles.region}>
      {isPhotoImageReadyFor(photo, { client: source, token, displayUntil: null }) && !failed ? (
        <Image
          accessibilityLabel="現在の店舗写真"
          source={{ uri: photo.asset.uri }}
          resizeMode="cover"
          style={styles.image}
          onError={() => setFailed(true)}
        />
      ) : unavailable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="店舗写真を再取得"
          style={styles.region}
          onPress={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          <Text style={styles.text}>{missing ? '写真なし・再取得' : '写真を再取得'}</Text>
        </Pressable>
      ) : (
        <Text style={styles.text}>写真を読み込み中</Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  region: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  image: { width: '100%', height: '100%' },
  text: { color: colors.muted, fontSize: typography.label, textAlign: 'center' },
});
