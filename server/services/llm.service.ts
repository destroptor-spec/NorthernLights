import OpenAI from 'openai';
import { getSystemSetting } from '../database';
import { getGenreVocabulary } from './genreMatrix.service';

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

  // Fetch MBDB vocabulary to constrain LLM genre choices
  const vocabulary = await getGenreVocabulary();
  const vocabStr = vocabulary.length > 0
    ? `\nYou MUST only use genre names from this vocabulary for "target_genres" and "banned_genres":\n${vocabulary.join(', ')}\nPrefer specific library-supported genres from the vocabulary over broad root genres. Use broad roots only when no specific vocabulary term fits.\n`
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
Only output valid JSON matching this schema:
{
  "hub_collections": [
    {
      "section": "Time-of-Day",
      "title": "Deep Work Coding",
      "description": "Driving electronic beats with zero vocals.",
      "target_genres": ["electronic", "ambient", "techno"],
      "banned_genres": ["rock", "metal", "country", "classical"],
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

export async function categorizeSubGenres(inputs: { subGenre?: string, artist?: string }[], vocabulary?: string[]): Promise<Record<string, string[]>> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return {};

  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey: apiKey,
  });

  const hasVocabulary = vocabulary && vocabulary.length > 0;
  const vocabularyStr = hasVocabulary
    ? `\nYou MUST ONLY return genre names from the following vocabulary list. Pick the closest 2-3 matches for each input. Do not invent genre names outside this list.\nVocabulary:\n${vocabulary.join(', ')}\n`
    : '';

  const prompt = `
Act as an expert musicologist. I am building a genre ontology and need to map specific artists or obscure sub-genres to genres in my database.
${vocabularyStr}
Inputs to categorize:
${inputs.map((inp, i) => `${i + 1}. ${inp.subGenre ? `Sub-Genre: ${inp.subGenre}` : `Artist: ${inp.artist}`}`).join('\n')}

Rules:
1. Return ONLY a JSON object where each key is the original input string (the sub-genre or artist name).
2. The value for each key MUST be an array of EXACTLY 2 OR 3 genre keywords that best encompass the input.
${hasVocabulary ? `3. You MUST NOT return genre names that do not appear in the vocabulary above. If no exact match exists, return the closest vocabulary terms.\n4. Order the array from most relevant to least relevant.` : `3. Order the array from most relevant to least relevant.`}

Return ONLY valid JSON exactly matching this schema:
{
  "mappings": {
    "swedish melodic death metal": ["metal", "death metal", "rock"],
    "daft punk": ["electronic", "house", "pop"]
  }
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }]
    }, { timeout: 120000 }); // 120 second timeout (local LLMs need more time with vocabulary)

    const content = response.choices[0].message.content;
    if (!content) {
      console.warn('[LLM Categorization] Empty response received from OpenAI.');
      return {};
    }

    const parsed = extractJson(content);
    if (!parsed || !parsed.mappings) {
       console.warn('[LLM Categorization] Invalid JSON returned from LLM. Expected {"mappings": {}}', content.slice(0, 200));
       return {};
    }

    // Validate that values are arrays of 2-3 strings
    const validatedMappings: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(parsed.mappings)) {
      if (Array.isArray(val) && val.length > 0) {
        validatedMappings[key] = val.map(String).slice(0, 3);
      } else {
        console.warn(`[LLM Categorization] Dropped key "${key}" due to invalid mapping value:`, val);
      }
    }

    return validatedMappings;
  } catch (e: any) {
    if (e.name === 'AbortError' || e.message?.includes('timeout')) {
      console.error('[LLM Categorization] Request timed out explicitly.');
    } else {
      console.error('[LLM Categorization] Fetching categorization failed', e.message);
    }
    return {};
  }
}

// Generate a single custom playlist concept based on a free-form user prompt.
// Returns a single HubCollection that can be passed straight to getHubCollections().
export async function generateCustomPlaylist(userPrompt: string): Promise<HubCollection | null> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return null;

  const openai = new OpenAI({ baseURL: baseUrl, apiKey });

  // Fetch MBDB vocabulary to constrain LLM genre choices
  const vocabulary = await getGenreVocabulary();
  const vocabStr = vocabulary.length > 0
    ? `\nYou MUST only use genre names from this vocabulary for "target_genres" and "banned_genres":\n${vocabulary.join(', ')}\nPrefer specific library-supported genres from the vocabulary over broad root genres. Use broad roots only when no specific vocabulary term fits.\n`
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

Only output valid JSON matching this schema exactly (the last four fields only when asked for):
{
  "section": "Custom",
  "title": "A short, catchy title for the playlist",
  "description": "A very short description matching the mood.",
  "target_genres": ["rock", "indie", "alternative"],
  "banned_genres": ["classical", "opera", "country"],
  "target_vector": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  "countries": ["DK"],
  "languages": ["da"],
  "year_from": 1990,
  "year_to": 1999
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
