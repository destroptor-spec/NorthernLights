/**
 * Moods from the sound (Essentia classifiers on Discogs-EffNet embeddings;
 * server/workers/extractor.py): five yes/no moods with high accuracy, and the
 * 56 MTG-Jamendo mood/theme tags, broad and noisy, used as hints.
 */
export const AUDIO_MOODS = ['happy', 'sad', 'relaxed', 'aggressive', 'party'] as const;
export type AudioMood = typeof AUDIO_MOODS[number];

/** MTG-Jamendo mood/theme classes in model order (mtg_jamendo_moodtheme-discogs-effnet-1.json). */
export const MOOD_THEMES = [
  'action', 'adventure', 'advertising', 'background', 'ballad', 'calm', 'children', 'christmas', 'commercial', 'cool',
  'corporate', 'dark', 'deep', 'documentary', 'drama', 'dramatic', 'dream', 'emotional', 'energetic', 'epic',
  'fast', 'film', 'fun', 'funny', 'game', 'groovy', 'happy', 'heavy', 'holiday', 'hopeful',
  'inspiring', 'love', 'meditative', 'melancholic', 'melodic', 'motivational', 'movie', 'nature', 'party', 'positive',
  'powerful', 'relaxing', 'retro', 'romantic', 'sad', 'sexy', 'slow', 'soft', 'soundscape', 'space',
  'sport', 'summer', 'trailer', 'travel', 'upbeat', 'uplifting',
] as const;
export type MoodTheme = typeof MOOD_THEMES[number];

/**
 * What an AI playlist can ask of the sound: the five moods, plus acoustic and
 * instrumental, which analysis already measures (acousticness and
 * instrumentalness in track_features). "Acoustic" there means real
 * instruments rather than electronic production: "Layla" scores 0.73, Foo
 * Fighters' "Everlong" 0.03. No model here tells unplugged from electric:
 * the MTG-Jamendo instrument head (tried 2026-11-12) put "Layla" above
 * "Sunday Morning Coming Down" for acoustic guitar.
 */
export const SOUND_QUALITIES = [...AUDIO_MOODS, 'acoustic', 'instrumental'] as const;
export type SoundQuality = typeof SOUND_QUALITIES[number];

/** Bumped when the models or the way scores are made change; the backfill redoes older rows. */
export const MOOD_SCORE_VERSION = 1;
