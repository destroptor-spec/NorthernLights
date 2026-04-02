import OpenAI from 'openai';
import { getSystemSetting } from '../database';

async function getLlmConfig() {
  const apiKey = (await getSystemSetting('llmApiKey')) || process.env.LLM_API_KEY || 'dummy-key';
  const baseUrl = (await getSystemSetting('llmBaseUrl')) || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const modelName = (await getSystemSetting('llmModelName')) || process.env.LLM_MODEL_NAME || 'gpt-4';
  return { apiKey, baseUrl, modelName };
}

// Robustly extract the first valid JSON object or array from an LLM response.
// Many local providers (LM Studio, Ollama) don't honour response_format and wrap
// JSON in markdown fences or add preamble text. This handles all common cases.
function extractJson(text: string): any {
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
  target_vector: [number, number, number, number, number, number, number];
  target_genre?: string; // A single macro-genre keyword (e.g. "r&b", "pop", "electronic")
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

  const macroGenreList = MACRO_GENRES.join(', ');

  const prompt = `
You are a Creative Director for a music application.
The user's current time is ${context.timeOfDay}. 
A brief summary of their recent listening history: ${context.historySummary}.

Using this context, generate ${conceptCount} Hub playlist concepts. Each concept must output optimal acoustic target values between 0.0 and 1.0.
IMPORTANT: Each concept must be DIVERSE from the others. Vary the energy, mood, and acoustic profile significantly between concepts. Do not create similar-sounding playlists.
The vector array must precisely match this order: [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability].
You must also include a "target_genre" field: a single lowercase genre keyword chosen from this list: ${macroGenreList}. Pick the genre that best matches the playlist's mood and concept.
Only output valid JSON matching this schema:
{
  "hub_collections": [
    {
      "section": "Time-of-Day",
      "title": "Deep Work Coding",
      "description": "Driving electronic beats with zero vocals.",
      "target_genre": "electronic",
      "target_vector": [0.6, 0.3, 0.8, 0.5, 0.9, 0.1, 0.8] 
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

export const MACRO_GENRES = [
  'pop', 'rock', 'hip-hop', 'r&b', 'electronic', 'edm/dance', 'house', 'techno', 
  'drum & bass', 'dubstep', 'trance', 'uk garage', 'breakbeat', 'electro', 
  'hardstyle/hardcore', 'downtempo', 'metal', 'punk', 'indie/alternative', 
  'jazz', 'blues', 'classical', 'folk/acoustic', 'country', 'reggae/dancehall', 
  'latin', 'soul/funk', 'ambient/new age', 'world/traditional', 'spoken word/audio', 
  'gospel/religious', 'soundtrack/score', 'children\'s music', 'holiday/seasonal', 
  'comedy/novelty', 'easy listening/lounge', 'experimental/avant-garde', 
  'afrobeats/african', 'k-pop/j-pop'
];

export async function categorizeSubGenres(inputs: { subGenre?: string, artist?: string }[]): Promise<Record<string, string>> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return {};

  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey: apiKey,
  });

  const prompt = `
Act as an expert musicologist. I am building a genre ontology. 
Objective: Map specific sub-genres or artists to one of the 20 approved Macro-Genres.

Approved Macro-Genres:
${MACRO_GENRES.join(', ')}

Inputs to categorize:
${inputs.map((inp, i) => `${i + 1}. ${inp.subGenre ? `Sub-Genre: ${inp.subGenre}` : `Artist: ${inp.artist}`}`).join('\n')}

Rules:
1. Return ONLY a JSON object where each key is the original input string (the sub-genre or artist name) and the value is the single MOST appropriate Macro-Genre from the list above.
2. If an input is ambiguous, use your best musicological judgment.
3. If completely unknown, use "spoken word/other".

Return ONLY valid JSON:
{
  "mappings": {
    "swedish melodic death metal": "metal",
    "daft punk": "electronic"
  }
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = response.choices[0].message.content;
    if (!content) return {};

    const parsed = extractJson(content);
    if (!parsed || !parsed.mappings) {
      console.warn('[LLM Genre] Could not extract mappings from response:', content.slice(0, 200));
      return {};
    }
    return parsed.mappings;
  } catch (err) {
    console.error('LLM Genre Categorization error', err);
    return {};
  }
}

// Generate a single custom playlist concept based on a free-form user prompt.
// Returns a single HubCollection that can be passed straight to getHubCollections().
export async function generateCustomPlaylist(userPrompt: string): Promise<HubCollection | null> {
  const { apiKey, baseUrl, modelName } = await getLlmConfig();
  if (baseUrl.includes('api.openai.com') && apiKey === 'dummy-key') return null;

  const openai = new OpenAI({ baseURL: baseUrl, apiKey });

  const macroGenreList = MACRO_GENRES.join(', ');

  const prompt = `
You are a Creative Director for a music application.
The user has asked you to create a playlist with the following description:
"${userPrompt}"

The vector array is a 7-dimensional fingerprint: [energy, brightness, percussiveness, chromagram, instrumentalness, acousticness, danceability].
- energy: 0 = completely silent/ambient, 1 = explosive/intense
- brightness: 0 = dark/bass-heavy, 1 = bright/trebly
- percussiveness: 0 = no drums, 1 = heavy drumming
- chromagram: 0 = atonal/noise, 1 = highly tonal/melodic
- instrumentalness: 0 = pure vocals, 1 = fully instrumental
- acousticness: 0 = fully electronic, 1 = fully acoustic
- danceability: 0 = not danceable (ambient/slow), 1 = highly danceable

Choose values that PRECISELY match the mood of the user's description. 
For example: "chill" or "wind-down" → low energy (0.1-0.3), high acousticness (0.6-0.9), low percussiveness (0.1-0.3), low danceability (0.1-0.3).

You must also include a "target_genre" field: a single lowercase genre keyword chosen from this list: ${macroGenreList}. Pick the genre that best matches the user's request.

Only output valid JSON matching this schema exactly:
{
  "section": "Custom",
  "title": "A short evocative playlist title",
  "description": "One sentence describing the vibe",
  "target_genre": "pop",
  "target_vector": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
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
