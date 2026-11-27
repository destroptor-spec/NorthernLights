// "At a glance" on the album page: a short, plain summary written from the
// release its files are tagged with (label, release dates, medium).
// Deterministic, and nothing the tags don't support; the album and artist
// are named, never "they".

export interface AlbumSummaryFacts {
    title: string;
    artist: string;
    /** Album, EP, Single, Compilation. */
    releaseType: string;
    label?: string | null;
    /** As tagged: "2011-04-12", "2011-04" or "2011". */
    releaseDate?: string | null;
    originalDate?: string | null;
    /** As tagged: "CD", "12\" Vinyl", "Digital Media". */
    media?: string | null;
    catalogNumber?: string | null;
    barcode?: string | null;
    /** MusicBrainz's, lowercase: official, promotion, bootleg, withdrawn, pseudo-release … */
    releaseStatus?: string | null;
    /** Where it was recorded (MusicBrainz), most tracks first. */
    recordedAt?: Array<{ name: string; area: string | null }> | null;
}

const MAX_PLACES = 3;

/** "Geejam Studios in Port Antonio"; the area left out when the name says it. */
const placeName = (place: { name: string; area: string | null }) =>
    place.area && !place.name.toLowerCase().includes(place.area.toLowerCase()) ? `${place.name} in ${place.area}` : place.name;

function list(items: string[]): string {
    return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Said only when it isn't the usual official release. A pseudo-release is a
// translated listing of a real one: nothing to say about the music.
const STATUS: Record<string, string> = {
    promotion: 'This is a promotional release.',
    bootleg: 'This is a bootleg.',
    withdrawn: 'This release was withdrawn.',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const KIND: Record<string, string> = { album: 'an album', ep: 'an EP', single: 'a single', compilation: 'a compilation' };

/** A tagged date in words: "12 April 2011", "April 2011", "2011"; null when it has no year. */
export function taggedDate(date: string): string | null {
    const [year, month, day] = date.split('-').map(Number);
    if (!year) return null;
    const monthName = month ? MONTHS[month - 1] : undefined;
    if (monthName && day) return `${day} ${monthName} ${year}`;
    if (monthName) return `${monthName} ${year}`;
    return `${year}`;
}

/** "on 12 April 2011", "in April 2011", "in 2011". */
function when(date: string): string | null {
    const text = taggedDate(date);
    if (!text) return null;
    return /^\d/.test(text) && text.includes(' ') ? `on ${text}` : `in ${text}`;
}

export const yearOf = (date?: string | null) => (date ? Number(date.slice(0, 4)) || null : null);

/** The medium as a name: "CD", "12″ vinyl", "Digital". */
export function mediumName(media: string): string {
    const text = medium(media);
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The medium in words: "the CD", "the 12″ vinyl", "the digital". */
function medium(media: string): string {
    const text = media.trim();
    if (/^digital( media)?$/i.test(text)) return 'digital';
    return text.replace(/"/g, '″').replace(/\bVinyl\b/, 'vinyl');
}

export function albumSummary(facts: AlbumSummaryFacts): string[] {
    const sentences: string[] = [];
    const title = facts.title.trim();
    const kind = KIND[facts.releaseType.toLowerCase()] ?? 'an album';
    const released = facts.releaseDate ? when(facts.releaseDate) : null;
    const label = facts.label?.trim();

    // Who, when and by whom: only with a date or a label (the kind and artist
    // alone are under the title already).
    if (released || label) {
        const parts = [released, label && `by ${label}`].filter(Boolean).join(' ');
        sentences.push(`${title} is ${kind} by ${facts.artist.trim()}, released ${parts}.`);
    }

    // A reissue: the music came out earlier than this release.
    const first = yearOf(facts.originalDate);
    const thisOne = yearOf(facts.releaseDate);
    if (first && thisOne && first < thisOne) sentences.push(`It first came out in ${first}.`);
    else if (first && !thisOne && !released) sentences.push(`It first came out in ${first}.`);

    const places = (facts.recordedAt ?? []).map(placeName);
    if (places.length > MAX_PLACES) sentences.push(`It was recorded at ${list(places.slice(0, MAX_PLACES))}, among other places.`);
    else if (places.length) sentences.push(`It was recorded at ${list(places)}.`);

    if (facts.media?.trim()) sentences.push(`Your copy is the ${medium(facts.media)} release.`);
    const status = facts.releaseStatus ? STATUS[facts.releaseStatus.toLowerCase()] : undefined;
    if (status) sentences.push(status);

    // For collectors: which pressing it is.
    const catalog = facts.catalogNumber?.trim();
    const code = facts.barcode?.trim();
    if (catalog && code) sentences.push(`Its catalog number is ${catalog} and its barcode ${code}.`);
    else if (catalog) sentences.push(`Its catalog number is ${catalog}.`);
    else if (code) sentences.push(`Its barcode is ${code}.`);
    return sentences;
}

/** The kind of disc a medium is, for the disc that rolls out of the cover. */
export function discKind(media?: string | null): 'cd' | 'vinyl' | null {
    if (!media) return null;
    if (/\b(cd|sacd|hdcd|compact disc)\b/i.test(media)) return 'cd';
    if (/vinyl|\blp\b|\d+″|\d+"/i.test(media)) return 'vinyl';
    return null;
}
