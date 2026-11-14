// Increment when feature semantics change; keep extractor.py FEATURE_VERSION in sync.
// v3 (2026-11): mean of three 15 s windows at 20/50/80 % instead of one at 35 %,
// plus genre_discogs400 style scores. See docs/Aurora genre and style redesign.md.
export const AUDIO_FEATURE_VERSION = 3;

// Shared by scanner selection and coverage reporting. Queries bind the current
// feature version as $1 and join track_features as tf (including missing rows).
export const PENDING_AUDIO_FEATURES_SQL = '(tf.acoustic_vector_8d IS NULL OR tf.feature_version < $1)';

// Style scores (track_style_scores) carry their own version, so a later change
// to the scoring model or windows can be backfilled without touching the
// embeddings Infinity searches on.
export const STYLE_SCORE_COUNT = 400;
export const STYLE_SCORE_VERSION = 1;
export const STYLE_SCORE_MODEL = 'genre_discogs400-discogs-effnet-1';
