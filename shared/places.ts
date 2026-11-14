/**
 * Places and languages for filtering and playlists ("Dansk rap fra
 * 90'erne"): one ISO code however a source spells it. Countries are ISO
 * 3166-1 alpha-2 ("DK"), languages ISO 639-1 ("da").
 *
 * Built from CLDR through Intl (no data shipped): country and language names
 * in many languages ("Denmark", "Danmark", "Dänemark", "danish", "dansk",
 * "dänisch", "danois"…), plus a short English list of what CLDR lacks:
 * demonyms ("american", "british") and UK nations. A language name stands for
 * its main country ("dansk" → DK) when used as a place.
 *
 * Shared by the server (sources) and the client (labels).
 */

/** Locales whose names count, chosen for the languages tags come in. */
const NAME_LOCALES = [
  'en', 'da', 'sv', 'nb', 'nn', 'fi', 'is', 'fo', 'de', 'nl', 'fr', 'es', 'it', 'pt', 'pl', 'cs', 'sk', 'hu', 'ro',
  'el', 'tr', 'ru', 'uk', 'hr', 'sr', 'sl', 'et', 'lv', 'lt', 'ga', 'cy', 'ja', 'ko', 'zh',
];

/** English names CLDR has no entry for: demonyms and UK nations. */
const EXTRA_COUNTRY_NAMES: Record<string, string> = {
  american: 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  british: 'GB', uk: 'GB', 'u.k.': 'GB', england: 'GB', english: 'GB', scotland: 'GB', scottish: 'GB',
  wales: 'GB', welsh: 'GB', 'northern ireland': 'GB', 'great britain': 'GB', britain: 'GB',
  irish: 'IE', australian: 'AU', canadian: 'CA', 'new zealand': 'NZ', kiwi: 'NZ', belgian: 'BE',
  jamaican: 'JM', brazilian: 'BR', austrian: 'AT', swiss: 'CH', mexican: 'MX', argentinian: 'AR', argentine: 'AR',
  colombian: 'CO', cuban: 'CU', 'puerto rican': 'PR', 'south african': 'ZA', nigerian: 'NG', ghanaian: 'GH',
  egyptian: 'EG', indian: 'IN', chinese: 'CN', taiwanese: 'TW', filipino: 'PH', israeli: 'IL', icelandic: 'IS',
  faroese: 'FO', faroe: 'FO', greenlandic: 'GL', estonian: 'EE', latvian: 'LV', lithuanian: 'LT', ukrainian: 'UA',
  belarusian: 'BY', bulgarian: 'BG', serbian: 'RS', croatian: 'HR', slovenian: 'SI', slovak: 'SK', czech: 'CZ',
  albanian: 'AL', moldovan: 'MD', turkish: 'TR', greek: 'GR', portuguese: 'PT', holland: 'NL', dutch: 'NL',
  'the netherlands': 'NL', korea: 'KR', 'south korea': 'KR', korean: 'KR', japanese: 'JP', canadien: 'CA',
  français: 'FR', francais: 'FR', québécois: 'CA', quebecois: 'CA',
};

/**
 * Words that look like a place in some language but are music terms ("indie"
 * is India in one locale) or name a US state as often as a country
 * ("georgia": Atlanta rappers). Genre-mapped tags never count as places
 * anyway; this catches the ones that aren't mapped.
 */
const NOT_PLACES = new Set(['indie', 'latin', 'soul', 'world', 'country', 'oriental', 'tropical', 'urban', 'christian', 'georgia', 'jersey']);

/** One-word tags that join a place to a genre or a language. */
const JOINED_PLACES: Record<string, string> = {
  deutschrap: 'DE', deutschpop: 'DE', deutschrock: 'DE', nederhop: 'NL', nederpop: 'NL', nederlandstalig: 'NL',
  danskpop: 'DK', danskrap: 'DK', danskrock: 'DK', svenskpop: 'SE', norskpop: 'NO', britpop: 'GB', kpop: 'KR', 'k-pop': 'KR',
  jpop: 'JP', 'j-pop': 'JP', 'j-rock': 'JP', cpop: 'CN', 'c-pop': 'CN', schlager: 'DE', chanson: 'FR',
};

/** Language names that mean "sung in" more than "from": their main country. */
const LANGUAGE_COUNTRY_OVERRIDES: Record<string, string> = { en: 'GB', pt: 'PT', es: 'ES', fr: 'FR', ar: 'EG', ga: 'IE', cy: 'GB' };

const LANGUAGES = [
  'da', 'sv', 'nb', 'nn', 'no', 'fi', 'is', 'fo', 'kl', 'de', 'nl', 'fr', 'es', 'it', 'pt', 'pl', 'cs', 'sk', 'hu', 'ro',
  'el', 'tr', 'ru', 'uk', 'be', 'bg', 'hr', 'sr', 'sl', 'et', 'lv', 'lt', 'ga', 'cy', 'gd', 'en', 'ja', 'ko', 'zh',
  'ar', 'he', 'hi', 'fa', 'af', 'sw', 'yo', 'ca', 'eu', 'gl', 'sq', 'mk', 'ka', 'hy', 'th', 'vi', 'id', 'ms', 'tl',
];

const norm = (s: string) => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

let countryNames: Map<string, string> | null = null;
let languageNames: Map<string, string> | null = null;
let regionCodes: string[] | null = null;

function allRegionCodes(): string[] {
  if (regionCodes) return regionCodes;
  const en = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const codes: string[] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const name = en.of(code);
    // User-assigned and grouping codes (XK aside) aren't countries, and an
    // alias ("UK") is its canonical code's (GB).
    if (!name || name === code || /^(EU|EZ|UN|QO|XA|XB|ZZ)$/.test(code)) continue;
    let canonical = code;
    try { canonical = new Intl.Locale(`und-${code}`).region ?? code; } catch { /* keep */ }
    if (canonical === code) codes.push(code);
  }
  return (regionCodes = codes);
}

function supported(type: 'region' | 'language'): Intl.DisplayNames[] {
  return Intl.DisplayNames.supportedLocalesOf(NAME_LOCALES).map(l => new Intl.DisplayNames([l], { type, fallback: 'none' }));
}

function buildCountryNames(): Map<string, string> {
  const map = new Map<string, string>();
  for (const names of supported('region')) {
    for (const code of allRegionCodes()) {
      const name = names.of(code);
      if (name) map.set(norm(name), code);
    }
  }
  for (const [name, code] of Object.entries(EXTRA_COUNTRY_NAMES)) map.set(norm(name), code);
  return map;
}

function buildLanguageNames(): Map<string, string> {
  const map = new Map<string, string>();
  for (const names of supported('language')) {
    for (const code of LANGUAGES) {
      const name = names.of(code);
      if (name) map.set(norm(name), code === 'nb' || code === 'nn' ? 'no' : code);
    }
  }
  return map;
}

/** ISO 3166-1 alpha-2 for a country name or code in any of the supported languages; null otherwise. */
export function countryCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = norm(value);
  if (EXTRA_COUNTRY_NAMES[key]) return EXTRA_COUNTRY_NAMES[key];
  if (/^[a-z]{2}$/.test(key)) {
    // Canonical codes only: CLDR aliases "UK" to GB.
    let code = key.toUpperCase();
    try { code = new Intl.Locale(`und-${code}`).region ?? code; } catch { /* keep */ }
    return allRegionCodes().includes(code) ? code : null;
  }
  countryNames ??= buildCountryNames();
  return countryNames.get(key) ?? null;
}

/**
 * ISO 639-1 for a language code ("dan", "da", "deu", "ger") or name
 * ("dansk", "Danish"); null for none, unknown, multiple or no lyrics
 * (und, mul, zxx).
 */
export function languageCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = norm(value);
  if (!key || ['und', 'mul', 'zxx', 'mis', 'xxx'].includes(key)) return null;
  if (/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(key)) {
    try {
      const canonical = Intl.getCanonicalLocales(key)[0];
      const language = new Intl.Locale(canonical).language;
      if (language.length === 2) return language === 'nb' || language === 'nn' ? 'no' : language;
    } catch { /* not a locale */ }
    // ISO 639-2 bibliographic codes CLDR doesn't alias.
    const bibliographic: Record<string, string> = { ger: 'de', fre: 'fr', dut: 'nl', gre: 'el', chi: 'zh', cze: 'cs', ice: 'is', wel: 'cy', rum: 'ro', slo: 'sk', alb: 'sq', arm: 'hy', geo: 'ka', mac: 'mk', per: 'fa' };
    if (bibliographic[key]) return bibliographic[key];
  }
  languageNames ??= buildLanguageNames();
  return languageNames.get(key) ?? null;
}

/**
 * The country a tag names ("danish", "dansk", "Denmark", "danmark",
 * "american", "UK"), or null. A language name stands for its main country.
 * Callers must skip tags that map to a genre or style first.
 */
export function placeFromTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const key = norm(tag);
  if (!key || NOT_PLACES.has(key)) return null;
  const country = countryCode(key);
  if (country) return country;
  if (JOINED_PLACES[key]) return JOINED_PLACES[key];
  // A place and a genre in one tag: "dansk rap", "danish rap", "german pop", "UK hip-hop".
  const words = key.split(' ');
  if (words.length > 1 && words[0].length >= 2) {
    const first = placeFromTag(words[0]);
    if (first && !NOT_PLACES.has(words[0])) return first;
  }
  if (key.length < 4) return null;
  languageNames ??= buildLanguageNames();
  const language = languageNames.get(key);
  if (!language) return null;
  if (LANGUAGE_COUNTRY_OVERRIDES[language]) return LANGUAGE_COUNTRY_OVERRIDES[language];
  try {
    return new Intl.Locale(language).maximize().region ?? null;
  } catch {
    return null;
  }
}

/** A country's name for display ("Denmark"); the code when unknown. */
export function countryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A language's name for display ("Danish"); the code when unknown. */
export function languageName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
