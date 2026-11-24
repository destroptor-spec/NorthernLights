// "At a glance" on the artist page: a short, plain summary written from what
// Aurora knows (MusicBrainz or TheAudioDB facts, the library's credits and
// counts, Last.fm listeners). Deterministic: the same facts always give the
// same sentences, and nothing is said that the facts don't support. No
// pronouns: the artist is named, so nobody is misgendered.

export interface ArtistSummaryFacts {
    name: string;
    /** MusicBrainz type: Person, Group, Orchestra, Choir, Character, Other. */
    type?: string;
    area?: string;
    lifeSpan?: { begin?: string; end?: string };
    /** Credited roles in the library (slugs: writer, dj-mixer), most first. */
    roles: string[];
    tracks: number;
    albums: number;
    /** Already formatted ("46 min", "4h 0m"); empty when too short to say. */
    duration?: string;
    /** Already formatted ("14K listeners"). */
    listeners?: string;
}

const KIND: Record<string, string> = {
    group: 'a group',
    person: 'an artist',
    orchestra: 'an orchestra',
    choir: 'a choir',
    character: 'a character',
};

// Places English names with "the" ("from the Netherlands"), when the area is
// the country itself rather than a city in it.
const WITH_THE = new Set([
    'bahamas', 'central african republic', 'comoros', 'czech republic', 'democratic republic of the congo',
    'dominican republic', 'gambia', 'isle of man', 'maldives', 'marshall islands', 'netherlands', 'philippines',
    'seychelles', 'solomon islands', 'united arab emirates', 'united kingdom', 'united states', 'vatican city',
]);

const ROLE_WORD: Record<string, string> = { 'dj-mixer': 'DJ mixer', 'original-artist': 'original artist' };
const MAX_ROLES = 4;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function list(items: string[]): string {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function place(area: string): string {
    return WITH_THE.has(area.trim().toLowerCase()) ? `the ${area.trim()}` : area.trim();
}

/** Years in words that suit the kind of artist; none when the kind is unknown. */
function years(type: string, lifeSpan: ArtistSummaryFacts['lifeSpan']): string | null {
    const begin = lifeSpan?.begin;
    const end = lifeSpan?.end;
    if (!begin) return null;
    if (type === 'person') return end ? `born in ${begin} and died in ${end}` : `born in ${begin}`;
    if (type === 'group' || type === 'orchestra' || type === 'choir') {
        return end ? `active from ${begin} to ${end}` : `formed in ${begin}`;
    }
    // Without a type the year could be a birth or a founding: say nothing.
    return null;
}

export function artistSummary(facts: ArtistSummaryFacts): string[] {
    const name = facts.name.trim();
    const type = (facts.type || '').toLowerCase();
    const kind = KIND[type];
    const sentences: string[] = [];

    // Who and where: "Daysend is a group from Sydney, Australia, active from 2002 to 2011."
    const from = facts.area ? `from ${place(facts.area)}` : '';
    const when = years(type, facts.lifeSpan);
    // The kind alone ("Seven Lions is an artist.") repeats the line under the
    // name: only with a place or years.
    if (kind && (from || when)) {
        sentences.push(`${name} is ${kind}${from ? ` ${from}` : ''}${when ? `, ${when}` : ''}.`);
    } else if (from) {
        sentences.push(`${name} is ${from}.`);
    }

    // The library: "Your library has 11 tracks from 1 album (46 min), where
    // Daysend is credited as performer and composer."
    const roles = facts.roles.map(role => ROLE_WORD[role.toLowerCase()] ?? role.toLowerCase().replace(/-/g, ' '));
    const roleList = roles.length > MAX_ROLES
        ? `${list(roles.slice(0, MAX_ROLES))}, among other roles`
        : list(roles);
    const credited = roles.length > 1 ? `credited as ${roleList}` : '';
    if (facts.tracks > 0) {
        const holdings = `${plural(facts.tracks, 'track')}${facts.albums > 0 ? ` from ${plural(facts.albums, 'album')}` : ''}`;
        const length = facts.duration ? ` (${facts.duration})` : '';
        sentences.push(`Your library has ${holdings}${length}${credited ? `, where ${name} is ${credited}` : ''}.`);
    } else if (credited) {
        sentences.push(`In your library, ${name} is ${credited}.`);
    }

    if (facts.listeners) sentences.push(`Last.fm counts ${facts.listeners}.`);
    return sentences;
}
