import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import type { EvidenceRef, PublicCard } from '@ima/contracts';
import type { JourneyPhotoClient } from '@mobile/platform/http/photo-client';
import { usePhotoImage } from '@mobile/journey/hooks/usePhotoImage';
import {
  isPhotoImageReadyFor,
  type PhotoImageIdentity,
  type PhotoImageState,
} from '@mobile/journey/state/photo-image-state';
import { presentFact } from '@mobile/journey/components/candidates/candidate-card-model';
import { colors, spacing, typography } from '@mobile/ui/theme/tokens';

type PhotoRegionProps = {
  readonly card: PublicCard;
  readonly client?: JourneyPhotoClient;
  readonly compact?: boolean;
  /** Edge length of the compact thumbnail; callers size it to their own row. */
  readonly compactSize?: number;
};

const photoDeadline = (evidence: readonly EvidenceRef[]): string | null => {
  const deadlines = evidence.flatMap((item) =>
    [
      item.retention.displayUntil,
      item.retention.sessionExpiresAt,
      item.retention.retentionUntil,
      item.retention.deletionScheduledAt,
    ].flatMap((value) => {
      if (value === null) return [];
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) ? [milliseconds] : [];
    }),
  );
  return deadlines.length === 0 ? null : new Date(Math.min(...deadlines)).toISOString();
};

const statusText = (state: PhotoImageState): string => {
  switch (state.status) {
    case 'expired':
      return '写真の表示期限が切れました';
    case 'unavailable':
      return '写真を表示できません';
    case 'idle':
    case 'loading':
      return '写真を読み込み中';
    case 'ready':
      return '';
  }
};

function PhotoSlide({
  token,
  displayUntil,
  client,
  compact,
  width,
  size,
}: {
  readonly token: string;
  readonly displayUntil: string | null;
  readonly client?: JourneyPhotoClient;
  readonly compact: boolean;
  readonly width: number;
  readonly size: number;
}): React.JSX.Element {
  const state = usePhotoImage(client, token, displayUntil);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [token]);
  const identity: PhotoImageIdentity | null =
    client === undefined ? null : { client, token, displayUntil };
  if (identity !== null && isPhotoImageReadyFor(state, identity) && !imageFailed) {
    return (
      <Image
        accessibilityLabel="候補の写真"
        onError={() => setImageFailed(true)}
        resizeMode="cover"
        source={{ uri: state.asset.uri }}
        style={[
          compact ? styles.compactImage : styles.heroImage,
          compact ? { height: size, width: size } : { width },
        ]}
      />
    );
  }
  return (
    <View
      style={[
        compact ? styles.compactUnavailable : styles.heroUnavailable,
        compact ? { height: size, width: size } : null,
      ]}
    >
      <Text style={styles.unavailableText}>
        {imageFailed ? '写真を表示できません' : statusText(state)}
      </Text>
    </View>
  );
}

/** Photo paging is nested in the visual region, so horizontal swipes never choose a candidate. */
export function PhotoRegion({
  card,
  client,
  compact = false,
  compactSize = 56,
}: PhotoRegionProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(compact ? compactSize : 0);
  const scrollRef = useRef<ScrollView>(null);
  const field = card.facts.photos;
  const presentation = presentFact(field, (value) => String(value.photos.length));
  const photoCount = field?.status === 'known' ? field.value.photos.length : 0;
  const photoKey =
    field?.status === 'known'
      ? field.value.photos.map((photo) => photo.photoToken).join('\u0000')
      : '';
  useEffect(() => {
    setActiveIndex(0);
    scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
  }, [card.candidateId, photoCount, photoKey]);
  if (field === undefined || presentation.status !== 'known' || field.status !== 'known') {
    return (
      <View
        style={[
          compact ? styles.compactPlaceholder : styles.heroPlaceholder,
          compact ? { height: compactSize, width: compactSize } : null,
        ]}
      >
        <Text style={styles.placeholderText}>
          {presentation.status === 'expired' ? '写真は表示期限を過ぎています' : presentation.label}
        </Text>
      </View>
    );
  }
  if (field.value.photos.length === 0) {
    return (
      <View
        style={[
          compact ? styles.compactPlaceholder : styles.heroPlaceholder,
          compact ? { height: compactSize, width: compactSize } : null,
        ]}
      >
        <Text style={styles.placeholderText}>写真なし</Text>
      </View>
    );
  }
  const displayUntil = photoDeadline(presentation.evidence);
  const pageWidth = compact ? compactSize : viewportWidth;
  return (
    <View
      style={[
        compact ? styles.compactRegion : styles.heroRegion,
        compact ? { height: compactSize, width: compactSize } : null,
      ]}
    >
      <ScrollView
        accessibilityLabel="候補の写真"
        contentContainerStyle={styles.scrollContent}
        horizontal
        nestedScrollEnabled
        onLayout={(event) => {
          if (!compact) setViewportWidth(event.nativeEvent.layout.width);
        }}
        onMomentumScrollEnd={(event) => {
          if (pageWidth <= 0) return;
          const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
          setActiveIndex(Math.max(0, Math.min(field.value.photos.length - 1, next)));
        }}
        pagingEnabled
        ref={scrollRef}
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
      >
        {field.value.photos.map((photo, index) => (
          <View key={photo.photoToken} style={[styles.slide, { width: pageWidth }]}>
            {index === activeIndex && pageWidth > 0 ? (
              <PhotoSlide
                compact={compact}
                displayUntil={displayUntil}
                size={compactSize}
                width={pageWidth}
                token={photo.photoToken}
                {...(client === undefined ? {} : { client })}
              />
            ) : (
              <View
                style={[
                  compact ? styles.compactPlaceholder : styles.heroUnavailable,
                  compact ? { height: compactSize, width: compactSize } : null,
                ]}
              >
                <Text style={styles.placeholderText}>写真</Text>
              </View>
            )}
          </View>
        ))}
      </ScrollView>
      {field.value.partialReason ? (
        <Text style={styles.partialReason}>{field.value.partialReason}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heroRegion: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#222224',
    // The card clips its own corners; rounding here would notch the photo
    // where it meets the body below it.
    overflow: 'hidden',
  },
  heroImage: {
    height: '100%',
    width: '100%',
  },
  heroPlaceholder: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: '#222224',
    justifyContent: 'center',
    padding: spacing.section,
  },
  heroUnavailable: {
    alignItems: 'center',
    backgroundColor: '#222224',
    height: '100%',
    justifyContent: 'center',
    padding: spacing.section,
    width: '100%',
  },
  compactRegion: {
    backgroundColor: '#222224',
    borderRadius: 12,
    height: 56,
    overflow: 'hidden',
    width: 56,
  },
  compactImage: {
    height: 56,
    width: 56,
  },
  compactPlaceholder: {
    alignItems: 'center',
    backgroundColor: '#222224',
    borderRadius: 12,
    height: 56,
    justifyContent: 'center',
    padding: 4,
    width: 56,
  },
  compactUnavailable: {
    alignItems: 'center',
    backgroundColor: '#222224',
    height: 56,
    justifyContent: 'center',
    padding: 4,
    width: 56,
  },
  placeholderText: {
    color: colors.faint,
    fontSize: typography.label,
    textAlign: 'center',
  },
  unavailableText: {
    color: colors.muted,
    fontSize: typography.label,
    textAlign: 'center',
  },
  partialReason: {
    backgroundColor: 'rgba(12, 12, 13, 0.72)',
    bottom: 4,
    color: colors.cream,
    fontSize: 10,
    left: 4,
    paddingHorizontal: 4,
    position: 'absolute',
    right: 4,
    textAlign: 'center',
  },
  scrollContent: {
    flexGrow: 1,
  },
  scrollView: {
    flex: 1,
  },
  slide: {
    height: '100%',
  },
});
