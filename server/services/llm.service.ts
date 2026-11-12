import OpenAI from 'openai';
import { getSystemSetting, initDB } from '../database';
import { getStyleVocabulary } from './genreTaxonomy/paths';
import { MOOD_NAMES } from '../../shared/descriptors';

export async function getLlmConfig() {
  const apiKey = (await getSystemSetting('llmApiKey')) || process.env.LLM_API_KEY || 'dummy-key';
  const baseUrl = (await getSystemSetting('llmBaseUrl')) || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const modelName = (await getSystemSetting('llmModelName')) || process.env.LLM_MODEL_NAME || 'gpt-4';
  return { apiKey, baseUrl, modelName };
}

// Robustly extract the first valid JSON object or array from an LLM response.
// Many local providers (LM Studio, Ollama) don't honour response_format and wrap
// JSON in markdown fences or add preamble text. This handles all common cases.
export function extractJson(text: string): any {
  // 1. Try parsing the whole string first (clean case)
  try { return JSON.parse(text); } catch { }

  // 2. Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { }
  }

  // 3. Extract the first {...} or [...] block
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { }
  }
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { }
  }

  return null;
}

export interface HubCollection {
  section: string;
  title?: string;
  description: string;
  target_vector: [number, number, number, number, number, number, number, number];
  target_genres?: string[];
  banned_genres?: string[];
  target_genre?: string; // Legacy singular field
  /** Custom playlists only, when asked for: ISO 3166-1 alpha-2 countries the artists are from. */
  countries?: string[];
  /** ISO 639-1 languages the songs are sung in. */
  languages?: string[];
  /** Release years, inclusive. */
  year_from?: number;
  year_to?: number;
  /** "female" or "male": by the artists' tags. */
  vocals?: string;
  /** Moods from MOOD_NAMES (shared/descriptors.ts): a preference, not a filter. */
  moods?: string[];
  /** 0 = about a mood, activity or feeling; 1 = about a genre or style. Sets how strictly the playlist keeps to target_genres. */
  focus?: number;
  /** How the music should sound, 0–1, on any of the five moods from the sound (shared/audioMoods.ts). */
  sound_moods?: Partial<Record<'happy' | 'sad' | 'relaxed' | 'aggressive' | 'party' | 'acoustic' | 'instrumental', number>>;
}

export async function generateHubConcepts(
  context: { timeOfDay: string, historySummary: string, count?: number }
): Promise<HubCollection[]> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return [];

  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey: apiKey,
  });

  const conceptCount = context.count ?? 3;

  // The library's own genres and styles, so the AI's choices map onto tracks.
  const vocabulary = await getStyleVocabulary(await initDB());
  const vocabStr = vocabulary.length > 0
    ? `\nYou MUST only use names from this list of the listener's genres and styles (most common first) for "target_genres" and "banned_genres":\n${vocabulary.join(', ')}\nPrefer specific styles over the broad genres at the start of the list. Use a broad genre only when no style fits.\n`
    : '';

  const prompt = `
You are a Creative Director for a music application.
The user's current time is ${context.timeOfDay}. 
A brief summary of their recent listening history: ${context.historySummary}.
${vocabStr}
Using this context, generate ${conceptCount} Hub playlist concepts. Each concept must output optimal acoustic target values between 0.0 and 1.0.
IMPORTANT: Each concept must be DIVERSE from the others. Vary the energy, mood, and acoustic profile significantly between concepts. Do not create similar-sounding playlists.
The vector array must precisely match this order: [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability, tempo].
- tempo: normalized BPM where 0.0 = 60 BPM (slow), 0.5 = 120 BPM (moderate), 1.0 = 200+ BPM (fast)
You must also include "target_genres": an array of 2-4 genre names that best match the playlist's mood and concept. Prefer specific, library-supported genre names so the recommendation engine can anchor the playlist locally.
You must also include "banned_genres": an array of 2-5 genre names that should be ABSOLUTELY EXCLUDED from this playlist. These are genres that clash with the playlist's mood (e.g., a "Club Fever" playlist should ban "rock", "country", "classical").
You must also include "focus": a number from 0 to 1 for what the playlist is mainly about. 1 = a genre or style ("90s Eurodance" 0.9, "Danish rap" 0.9, "Dinner jazz" 0.7); 0 = a mood, an activity or a feeling, whatever the genre ("Music for coding" 0.1, "Rainy day" 0.2). Both count in "Melancholic indie rock for a rainy day" (0.6). When the request names a genre or style, focus is at least 0.5: the mood then chooses within it. A low focus lets close-sounding music from neighbouring genres in; a high one keeps to the genres.
You must also include "sound_moods": how the music should sound, on these scales from 0 to 1; include only the ones that matter for this playlist. happy = bright and cheerful; sad = slow, soft, tender or wistful (whatever the lyrics are about; a tender love ballad counts); relaxed = calm and unhurried; aggressive = hard, loud and intense; party = danceable and festive; acoustic = played on real instruments rather than produced electronically (a rock band counts as well as an unplugged guitar; low for electronic music); instrumental = without vocals. Examples: a rainy day {"sad": 0.8, "relaxed": 0.8, "party": 0.1}; music for coding {"relaxed": 0.8, "instrumental": 0.8, "aggressive": 0.1, "party": 0.1}; an acoustic Sunday morning {"relaxed": 0.9, "happy": 0.6, "acoustic": 0.9}; gym metal {"aggressive": 0.9, "relaxed": 0.1}; a 90s dance party {"party": 0.9, "happy": 0.7, "acoustic": 0.1}.
Only output valid JSON matching this schema:
{
  "hub_collections": [
    {
      "section": "Time-of-Day",
      "title": "Deep Work Coding",
      "description": "Driving electronic beats with zero vocals.",
      "target_genres": ["Ambient", "Techno", "Downtempo"],
      "banned_genres": ["Rock", "Heavy Metal", "Country", "Classical"],
      "focus": 0.2,
      "sound_moods": { "relaxed": 0.7, "aggressive": 0.1, "party": 0.2 },
      "target_vector": [0.6, 0.3, 0.8, 0.5, 0.9, 0.1, 0.8, 0.7] 
    }
  ]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0].message.content;
    if (!content) return [];

    const parsed = extractJson(content);
    if (!parsed) {
      console.warn('[LLM Hub] Could not extract JSON from response:', content.slice(0, 200));
      return [];
    }
    return parsed.hub_collections || [];
  } catch (err) {
    console.error('LLM Hub Generation error', err);
    return [];
  }
}

export async function generateCustomPlaylist(userPrompt: string): Promise<HubCollection | null> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return null;

  const openai = new OpenAI({ baseURL: baseUrl, apiKey });

  // The library's own genres and styles, so the AI's choices map onto tracks.
  const vocabulary = await getStyleVocabulary(await initDB());
  const vocabStr = vocabulary.length > 0
    ? `\nYou MUST only use names from this list of the listener's genres and styles (most common first) for "target_genres" and "banned_genres":\n${vocabulary.join(', ')}\nPrefer specific styles over the broad genres at the start of the list. Use a broad genre only when no style fits.\n`
    : '';

  const prompt = `
You are a Creative Director for a music application.
The user has asked you to create a playlist with the following description:
"${userPrompt}"
${vocabStr}
The vector array is an 8-dimensional fingerprint: [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability, tempo].
- energy: 0 = completely silent/ambient, 1 = explosive/intense
- brightness: 0 = dark/bass-heavy, 1 = bright/trebly
- percussiveness: 0 = no drums, 1 = heavy drumming
- chromagram: 0 = atonal/noise, 1 = highly tonal/melodic
- instrumentalness: 0 = pure vocals, 1 = fully instrumental
- acousticness: 0 = fully electronic, 1 = fully acoustic
- danceability: 0 = not danceable (ambient/slow), 1 = highly danceable
- tempo: normalized BPM where 0.0 = 60 BPM (slow), 0.5 = 120 BPM (moderate), 1.0 = 200+ BPM (fast)

Choose values that PRECISELY match the mood of the user's description. 
For example: "chill" or "wind-down" → low energy (0.1-0.3), high acousticness (0.6-0.9), low percussiveness (0.1-0.3), low danceability (0.1-0.3).

You must also include "target_genres": an array of 2-4 genre names that best match the user's request. Prefer specific, library-supported genre names so the recommendation engine can anchor the playlist locally.
You must also include "banned_genres": an array of 2-5 genre names that should be ABSOLUTELY EXCLUDED from this playlist. These are genres that clash with the playlist's mood.

The description may be written in any language (for example Danish: "Dansk rap fra 90'erne" means Danish rap from the 1990s). Write the title and description in the language the user wrote in.
Only when the user asks for where the music is from, the language it is sung in, or when it was released, also include these hard filters (leave them out otherwise; every track must match them):
- "countries": ISO 3166-1 alpha-2 codes of the countries the artists come from. "Dansk rap", "Danish rap" → ["DK"]; "Nordic pop" → ["DK", "SE", "NO", "FI", "IS"].
- "languages": ISO 639-1 codes of the languages the songs are sung in. "på dansk", "sung in Danish" → ["da"]. For a nationality ("Dansk rap") give both the country and its language: a track matches either.
- "year_from" and "year_to": release years, inclusive. "fra 90'erne", "from the 90s" → 1990 and 1999; "after 2010" → year_from 2010 only.
- "vocals": "female" or "male", only when the user asks for the singer's voice ("med kvindelig vokal", "female singers").
Also include "moods" when the description has a mood: 1-3 of ${MOOD_NAMES.join(', ')}. They gently favour artists known for that mood; the target_vector still sets the sound.
You must also include "focus": a number from 0 to 1 for what the playlist is mainly about. 1 = a genre or style ("90s Eurodance" 0.9, "Danish rap" 0.9, "Dinner jazz" 0.7); 0 = a mood, an activity or a feeling, whatever the genre ("Music for coding" 0.1, "Rainy day" 0.2). Both count in "Melancholic indie rock for a rainy day" (0.6). When the request names a genre or style, focus is at least 0.5: the mood then chooses within it. A low focus lets close-sounding music from neighbouring genres in; a high one keeps to the genres.
You must also include "sound_moods": how the music should sound, on these scales from 0 to 1; include only the ones that matter for this playlist. happy = bright and cheerful; sad = slow, soft, tender or wistful (whatever the lyrics are about; a tender love ballad counts); relaxed = calm and unhurried; aggressive = hard, loud and intense; party = danceable and festive; acoustic = played on real instruments rather than produced electronically (a rock band counts as well as an unplugged guitar; low for electronic music); instrumental = without vocals. Examples: a rainy day {"sad": 0.8, "relaxed": 0.8, "party": 0.1}; music for coding {"relaxed": 0.8, "instrumental": 0.8, "aggressive": 0.1, "party": 0.1}; an acoustic Sunday morning {"relaxed": 0.9, "happy": 0.6, "acoustic": 0.9}; gym metal {"aggressive": 0.9, "relaxed": 0.1}; a 90s dance party {"party": 0.9, "happy": 0.7, "acoustic": 0.1}.

Only output valid JSON matching this schema exactly (countries, languages, year_from, year_to and vocals only when asked for):
{
  "section": "Custom",
  "title": "A short, catchy title for the playlist",
  "description": "A very short description matching the mood.",
  "target_genres": ["Indie Rock", "Alternative Rock", "Shoegaze"],
  "banned_genres": ["Classical", "Opera", "Country"],
  "focus": 0.6,
  "sound_moods": { "sad": 0.6, "relaxed": 0.7 },
  "target_vector": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  "countries": ["DK"],
  "languages": ["da"],
  "year_from": 1990,
  "year_to": 1999,
  "vocals": "female",
  "moods": ["chill"]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.choices[0].message.content;
    if (!content) return null;
    const parsed = extractJson(content);

    // Robustly handle both singular/plural names if LLM deviates
    const vector = parsed?.target_vector || parsed?.target_vectors;

    if (!parsed || !Array.isArray(vector)) {
      console.warn('[LLM Custom Playlist] Could not extract valid concept:', content.slice(0, 200));
      return null;
    }

    const concept = { ...parsed, target_vector: vector };
    console.log(`[LLM Custom Playlist] Generated concept: "${concept.title}" with vector: [${vector.join(',')}]`);
    return concept as HubCollection;
  } catch (err) {
    console.error('LLM Custom Playlist Generation error', err);
    return null;
  }
}

/** A theme as the AI sees it in the special-list menu. */
export interface SpecialMenuEntry { key: string; label: string; kind: string; songs: number; artists: number; describe?: string }
/** The AI's pick for a special list: a theme from the menu, named. */
export interface SpecialPick { theme: string; title: string; description: string; target_vector: number[] }

/**
 * Special lists: the AI picks `count` themes from the menu (by key, all
 * different, varied in kind) and names each one; the library has already
 * decided what each theme is and that it can carry it.
 */
export async function generateSpecialPicks(
  menu: SpecialMenuEntry[],
  count: number,
  context: { timeOfDay?: string; historySummary?: string } = {},
): Promise<SpecialPick[]> {
  if (!menu.length || count <= 0) return [];
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return [];
  const openai = new OpenAI({ baseURL: baseUrl, apiKey });
  const lines = menu.map(m => `- ${m.key} | ${m.label}${m.describe ? ` (${m.describe})` : ''} | ${m.kind} | ${m.songs} songs, ${m.artists} artists`).join('\n');
  const prompt = `
You are a Creative Director for a music application. These are themes the listener's own library can carry (key | theme | kind | size):
${lines}
${context.timeOfDay ? `The listener's time of day is ${context.timeOfDay}.` : ''}${context.historySummary ? ` Recently played: ${context.historySummary}.` : ''}

Pick exactly ${count} different themes from the list (prefer different kinds, and themes that suit the listener now) and name each as a special playlist: a short, specific, inviting title (e.g. "Trance Horizon", "Danish Rap Commute", "Music for Code") and a one-line description. Do not invent themes; use the keys exactly as written.
Also give "target_vector", the sound of the playlist as 8 numbers from 0 to 1: [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability, tempo] (tempo 0 = 60 BPM, 0.5 = 120 BPM, 1 = 200 BPM).

Only output valid JSON:
{
  "special_lists": [
    { "theme": "style:123", "title": "Trance Horizon", "description": "Euphoric, melodic trance for the long way home.", "target_vector": [0.8, 0.7, 0.6, 0.8, 0.6, 0.1, 0.8, 0.6] }
  ]
}
`;
  try {
    const response = await openai.chat.completions.create({ model: modelName, messages: [{ role: 'user', content: prompt }] });
    const parsed = extractJson(response.choices[0].message.content || '');
    const keys = new Set(menu.map(m => m.key));
    const seen = new Set<string>();
    return (Array.isArray(parsed?.special_lists) ? parsed.special_lists : [])
      .filter((p: any) => p && keys.has(p.theme) && !seen.has(p.theme) && seen.add(p.theme)
        && typeof p.title === 'string' && Array.isArray(p.target_vector) && p.target_vector.length === 8)
      .slice(0, count);
  } catch (err) {
    console.error('LLM special list error', err);
    return [];
  }
}
