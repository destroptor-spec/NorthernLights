// Increment when feature semantics change; keep extractor.py FEATURE_VERSION in sync.
export const AUDIO_FEATURE_VERSION = 2;

// Shared by scanner selection and coverage reporting. Queries bind the current
// feature version as $1 and join track_features as tf (including missing rows).
export const PENDING_AUDIO_FEATURES_SQL = '(tf.acoustic_vector_8d IS NULL OR tf.feature_version < $1)';
