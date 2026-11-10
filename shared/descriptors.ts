/**
 * Descriptors from artist tags (Last.fm, MusicBrainz) that aren't genres:
 * the vocals ("female vocalists"), the mood ("chillout", "melancholic") and
 * the era ("80s", "1980s", "80'erne"). One canonical value however a tag
 * spells it, in English and the Scandinavian, German and Dutch spellings tags
 * come in. They describe an artist's career, not one track, so they filter
 * and steer playlists; they never become genres.
 *
 * Shared by the server (sources) and the client (labels).
 */

export type DescriptorKind = 'vocals' | 'mood' | 'era';

export const VOCALS = ['female', 'male'] as const;
export type Vocals = typeof VOCALS[number];

/** Moods, with the words tags use for them. */
export const MOODS = {
  chill: ['chill', 'chillout', 'chill out', 'chill-out', 'chilled', 'chilled out', 'relaxing', 'relax', 'relaxed', 'mellow', 'calm', 'smooth', 'laid back', 'laid-back', 'rolig', 'afslappende', 'avslappnande', 'entspannt'],
  party: ['party', 'party music', 'feel good party', 'fest', 'festlig', 'feest'],
  uplifting: ['uplifting', 'happy', 'feel good', 'feel-good', 'feelgood', 'euphoric', 'positive', 'cheerful', 'glad', 'glade', 'glücklich', 'vrolijk'],
  melancholic: ['melancholic', 'melancholy', 'melancholia', 'sad', 'depressing', 'depressive', 'sorrow', 'trist', 'melankolsk', 'melankoli', 'traurig', 'droevig'],
  dark: ['dark', 'darkness', 'brooding', 'sinister', 'mørk', 'mörk', 'düster', 'duister'],
  atmospheric: ['atmospheric', 'ethereal', 'dreamy', 'dreamlike', 'spacey', 'atmosfærisk', 'atmosfärisk'],
  romantic: ['romantic', 'love', 'love songs', 'love song', 'sexy', 'sensual', 'romantisk', 'romantisch', 'kærlighed'],
  energetic: ['energetic', 'energy', 'aggressive', 'intense', 'powerful', 'hard hitting', 'energisk', 'energiek'],
  funky: ['funky', 'groovy', 'groove'],
} as const;
export type Mood = keyof typeof MOODS;
export const MOOD_NAMES = Object.keys(MOODS) as Mood[];

const MOOD_LABELS: Record<Mood, string> = {
  chill: 'Chill', party: 'Party', uplifting: 'Uplifting', melancholic: 'Melancholic', dark: 'Dark',
  atmospheric: 'Atmospheric', romantic: 'Romantic', energetic: 'Energetic', funky: 'Funky',
};

const VOCAL_WORDS: Record<Vocals, string[]> = {
  female: ['female vocalists', 'female vocalist', 'female vocals', 'female vocal', 'female voice', 'female voices', 'female singer',
    'female singers', 'female', 'female fronted', 'female-fronted', 'female fronted metal', 'female fronted rock', 'girl group',
    'girl groups', 'girl band', 'diva', 'divas', 'kvindelig vokal', 'kvindelige vokaler', 'kvinnlig sång', 'weibliche stimme', 'vrouwelijke zang'],
  male: ['male vocalists', 'male vocalist', 'male vocals', 'male vocal', 'male voice', 'male singer', 'male singers', 'male',
    'boy band', 'boyband', 'boybands', 'boy bands', 'mandlig vokal', 'mandlige vokaler', 'manlig sång', 'männliche stimme', 'mannelijke zang'],
};

const norm = (s: string) => s.normalize('NFC').trim().toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');

let lookup: Map<string, { kind: 'vocals' | 'mood'; value: string }> | null = null;
function words() {
  if (lookup) return lookup;
  lookup = new Map();
  for (const [value, list] of Object.entries(VOCAL_WORDS)) for (const w of list) lookup.set(norm(w), { kind: 'vocals', value });
  for (const [value, list] of Object.entries(MOODS)) for (const w of list) lookup.set(norm(w), { kind: 'mood', value });
  return lookup;
}

/**
 * The decade a tag names: "80s", "80's", "1980s", "eighties", "80er",
 * "80'erne", "00s", "2010s". Two digits below 30 are 2000s ("00s", "10s",
 * "20s" being 2020s only when written "2020s"; a bare "20s" is the 1920s).
 */
export function eraOf(tag: string | null | undefined): number | null {
  if (!tag) return null;
  const key = norm(tag);
  const words: Record<string, number> = {
    fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000, 'two thousands': 2000,
    halvfjerdserne: 1970, firserne: 1980, halvfemserne: 1990,
  };
  if (words[key] !== undefined) return words[key];
  const full = /^(19[2-9]0|20[0-2]0)'?s$/.exec(key) ?? /^(19[2-9]0|20[0-2]0)(er|erne|'erne|-tallet|talet)$/.exec(key);
  if (full) return Number(full[1]);
  const short = /^([0-9]0)(?:'?s|er|erne|'erne|'er)$/.exec(key);
  if (short) {
    const n = Number(short[1]);
    return n <= 10 ? 2000 + n : 1900 + n;
  }
  return null;
}

/** What a non-genre tag says about an artist's vocals, mood or era, or null. */
export function descriptorOf(tag: string | null | undefined): { kind: DescriptorKind; value: string } | null {
  if (!tag) return null;
  const era = eraOf(tag);
  if (era !== null) return { kind: 'era', value: String(era) };
  return words().get(norm(tag)) ?? null;
}

/** A mood or vocals value in words, for labels and logs. */
export function descriptorLabel(kind: DescriptorKind, value: string): string {
  if (kind === 'mood') return MOOD_LABELS[value as Mood] ?? value;
  if (kind === 'vocals') return value === 'female' ? 'Female vocals' : value === 'male' ? 'Male vocals' : value;
  return `${value}s`;
}

/** Normalises what a model or a request says ("female", "kvindelig vokal") to a vocals value. */
export function vocalsOf(value: unknown): Vocals | null {
  if (typeof value !== 'string') return null;
  const key = norm(value);
  if ((VOCALS as readonly string[]).includes(key)) return key as Vocals;
  const found = words().get(key);
  return found?.kind === 'vocals' ? found.value as Vocals : null;
}

/** Normalises a mood name or word ("chillout", "trist") to a mood, or null. */
export function moodOf(value: unknown): Mood | null {
  if (typeof value !== 'string') return null;
  const key = norm(value);
  if ((MOOD_NAMES as string[]).includes(key)) return key as Mood;
  const found = words().get(key);
  return found?.kind === 'mood' ? found.value as Mood : null;
}
