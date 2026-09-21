import type { PhotoPath, SavedReferencePath, ThreadPath } from '@worker/adapters/in/http/handler';

export type LifecycleAction = 'cancel' | 'resume' | 'restart' | 'end';

export type MatchedRoute =
  | { readonly kind: 'attest_nonce' }
  | { readonly kind: 'attest_enroll' }
  | { readonly kind: 'attest_revoke' }
  | { readonly kind: 'create_thread' }
  | { readonly kind: 'search' }
  | { readonly kind: 'photos'; readonly path: PhotoPath }
  | { readonly kind: 'prefs_read' }
  | { readonly kind: 'prefs_write' }
  | { readonly kind: 'saved_reference_list' }
  | { readonly kind: 'saved_reference_refresh'; readonly path: SavedReferencePath }
  | { readonly kind: 'saved_reference_create'; readonly path: ThreadPath }
  | { readonly kind: 'saved_reference_delete'; readonly path: SavedReferencePath }
  | { readonly kind: 'place_decide'; readonly path: ThreadPath }
  | { readonly kind: 'events' }
  | { readonly kind: 'turn'; readonly path: ThreadPath }
  | { readonly kind: 'read_thread'; readonly path: ThreadPath }
  | { readonly kind: 'replay_thread'; readonly path: ThreadPath }
  | {
      readonly kind: 'lifecycle';
      readonly action: LifecycleAction;
      readonly path: ThreadPath;
    }
  | { readonly kind: 'delete_thread'; readonly path: ThreadPath };
