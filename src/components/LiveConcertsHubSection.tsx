import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { MapPin, Calendar, ArrowRight, Headphones, AlertTriangle, Play } from 'lucide-react';
import { HorizontalScrollRail } from './HorizontalScrollRail';
import { auroraApiRequest, type Track } from '../api/auroraApi';
import { toPlayableTracks } from '../utils/playableTracks';
import { shuffled } from '../utils/shuffle';
import { eventProximity } from '../utils/eventProximity';

type HubEvent = {
    jambase_event_id: string;
    artist_id: string;
    artist_name: string;
    artist_image_url: string | null;
    event_date: string;
    event_datetime: string | null;
    venue_name: string | null;
    venue_city: string | null;
    venue_region: string | null;
    venue_country: string | null;
    venue_lat: number | null;
    venue_lng: number | null;
    ticket_url: string | null;
    price_min: number | null;
    price_max: number | null;
    price_currency: string | null;
    status: string | null;
};

type HubResponse = {
    events: HubEvent[];
    disabled?: boolean;
    stale?: boolean;
};

// Compact human date — relies on Intl rather than a formatting lib so we get
// locale-aware weekday names without bringing in date-fns.
function formatEventDate(dateStr: string, datetime: string | null): { weekday: string; date: string; time: string | null } {
    const d = new Date(datetime || `${dateStr}T00:00:00`);
    if (!Number.isFinite(d.getTime())) {
        return { weekday: '', date: dateStr, time: null };
    }
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    let time: string | null = null;
    if (datetime && datetime.length > 10) {
        // Jambase returns local-to-venue wall clock without timezone — use it raw.
        const hh = datetime.slice(11, 13);
        const mm = datetime.slice(14, 16);
        if (hh && mm && !(hh === '00' && mm === '00')) {
            const hour = parseInt(hh, 10);
            const ampm = hour >= 12 ? 'pm' : 'am';
            const h12 = hour % 12 || 12;
            time = `${h12}:${mm} ${ampm}`;
        }
    }
    return { weekday, date: datePart, time };
}

function formatPrice(min: number | null, max: number | null, currency: string | null): string | null {
    if (min == null && max == null) return null;
    const cur = (currency || 'USD').toUpperCase();
    const symbol = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'NOK' ? 'kr ' : `${cur} `;
    if (min != null && max != null && max > min) {
        return `${symbol}${Math.round(min)}–${Math.round(max)}`;
    }
    return `from ${symbol}${Math.round((min ?? max)!)}`;
}

function venueLine(e: HubEvent): string {
    const parts: string[] = [];
    if (e.venue_name) parts.push(e.venue_name);
    const city = e.venue_city || '';
    const region = e.venue_region || '';
    const country = e.venue_country || '';
    const locality = [city, region || country].filter(Boolean).join(', ');
    if (locality) parts.push(locality);
    return parts.join(' · ');
}

interface TicketCardProps {
    event: HubEvent;
}

/**
 * Warm up: the artist's own tracks from the library, shuffled, so the listener
 * can play them before the show. On the ticket's stub; revealed on hover where
 * there is a pointer, always there on touch screens (`.concert-warmup`).
 */
export const WarmUpButton: React.FC<{ artistId: string; artistName: string }> = ({ artistId, artistName }) => {
    const setPlaylist = usePlayerStore(s => s.setPlaylist);
    const addToast = usePlayerStore(s => s.addToast);
    const [loading, setLoading] = useState(false);

    const warmUp = async () => {
        if (loading) return;
        setLoading(true);
        try {
            const data = await auroraApiRequest<{ tracks: Track[] }>(
                `/artists/${encodeURIComponent(artistId)}`, usePlayerStore.getState().getAuthHeader(),
            );
            const all = toPlayableTracks(data?.tracks ?? []);
            // Their own tracks: the endpoint also returns DJ-mix tracks they only appear on.
            const own = all.filter(track => track.artistId === artistId);
            const tracks = shuffled(own.length ? own : all);
            if (tracks.length === 0) {
                addToast(`No tracks by ${artistName} in your library`, 'info');
                return;
            }
            await setPlaylist(tracks, 0, { kind: 'artist', id: artistId, name: `${artistName} warm-up` });
        } catch {
            addToast(`Could not play ${artistName}`, 'error', { actionLabel: 'Retry', onAction: () => void warmUp() });
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            type="button"
            className="btn-fab concert-warmup"
            onClick={warmUp}
            aria-label={`Warm up: shuffle ${artistName} from your library`}
            title={`Warm up: shuffle ${artistName}`}
            aria-busy={loading || undefined}
        >
            {loading
                ? <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <Play className="h-4 w-4 ml-0.5" fill="currentColor" aria-hidden="true" />}
        </button>
    );
};

const TicketCard: React.FC<TicketCardProps> = ({ event }) => {
    const { weekday, date, time } = formatEventDate(event.event_date, event.event_datetime);
    const price = formatPrice(event.price_min, event.price_max, event.price_currency);
    const venue = venueLine(event);
    // "tonight", "tomorrow", "this saturday", "in 9 days"; nothing further out.
    const soon = eventProximity(event.event_date, event.event_datetime);
    const imminent = soon === 'tonight' || soon === 'today' || soon === 'tomorrow';
    // "this saturday" and the first three name the day already.
    const showWeekday = !soon || soon.startsWith('in ');

    return (
        <article
            className="
                concert-ticket card-hover
                relative flex-shrink-0 snap-start
                w-[85vw] max-w-[380px] sm:w-[340px] md:w-[380px]
                bg-[var(--color-surface)]
                rounded-2xl overflow-hidden
            "
            aria-label={`${event.artist_name}${soon ? `, ${soon},` : ''} on ${weekday} ${date} at ${event.venue_name || 'venue'}`}
        >
            <div className="relative flex">
                {/* Stub: artist image, with Warm up beside the link (a button can't sit inside one) */}
                <div className="relative shrink-0 w-24 sm:w-28">
                    {/* The artist's name is the keyboard and screen-reader link; this is the pointer's. */}
                    <Link
                        to={`/library/artist/${event.artist_id}`}
                        className="group relative block h-full w-full"
                        tabIndex={-1}
                        aria-hidden="true"
                    >
                        <div className="absolute inset-0 bg-[var(--color-surface-variant)]" />
                        {event.artist_image_url ? (
                            <img
                                src={event.artist_image_url}
                                alt=""
                                loading="lazy"
                                className="relative w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            />
                        ) : (
                            <div className="relative w-full h-full flex items-center justify-center text-[var(--color-text-muted)]">
                                <Headphones size={28} />
                            </div>
                        )}
                        {/* Subtle dimming gradient at the perforation edge for depth */}
                        <div
                            className="absolute inset-y-0 right-0 w-4 bg-gradient-to-r from-transparent to-black/[0.05] dark:to-white/[0.04]"
                            aria-hidden="true"
                        />
                    </Link>
                    <WarmUpButton artistId={event.artist_id} artistName={event.artist_name} />
                </div>

                {/* Perforation between stub and body */}
                <div className="shrink-0 self-stretch border-l border-dashed border-[var(--glass-border)]" aria-hidden="true" />


                {/* Body */}
                <div className="flex-1 min-w-0 p-4 flex flex-col gap-2">
                    <div className="flex items-baseline gap-2">
                        <Calendar size={14} className="text-[var(--color-primary)] flex-shrink-0 self-center" />
                        <div className="flex flex-wrap items-baseline gap-x-1.5 min-w-0">
                            {soon && (
                                <span className={`concert-soon whitespace-nowrap text-xs font-semibold ${imminent ? 'text-[var(--color-primary-fill)]' : 'text-[var(--color-text-secondary)]'}`}>
                                    {soon}
                                </span>
                            )}
                            {soon && <span className="text-xs text-[var(--color-text-muted)]" aria-hidden="true">·</span>}
                            {showWeekday && (
                                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] tabular-nums">
                                    {weekday}
                                </span>
                            )}
                            <span className="text-sm font-bold text-[var(--color-text-primary)] tabular-nums">
                                {date}
                            </span>
                            {time && (
                                <span className="text-xs text-[var(--color-text-muted)] tabular-nums truncate">
                                    · {time}
                                </span>
                            )}
                        </div>
                    </div>

                    <h3 className="text-base font-bold text-[var(--color-text-primary)] line-clamp-1 leading-tight">
                        <Link
                            to={`/library/artist/${event.artist_id}`}
                            className="hover:text-[var(--color-primary)] transition-colors"
                        >
                            {event.artist_name}
                        </Link>
                    </h3>

                    {venue && (
                        <div className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)] min-w-0">
                            <MapPin size={12} className="text-[var(--color-text-muted)] flex-shrink-0 mt-0.5" />
                            <span className="line-clamp-2 leading-snug">{venue}</span>
                        </div>
                    )}

                    {/* As tall as the tickets button with or without one, so every ticket in the rail matches. */}
                    <div className="flex min-h-[44px] items-center justify-between gap-2 mt-auto pt-2">
                        {price ? (
                            <span className="text-xs font-semibold text-[var(--color-text-secondary)] tabular-nums">
                                {price}
                            </span>
                        ) : event.status === 'scheduled' ? (
                            <span className="text-xs text-[var(--color-text-muted)]">
                                tickets available
                            </span>
                        ) : (
                            <span className="text-xs text-[var(--color-text-muted)]">
                                {event.status}
                            </span>
                        )}
                        {event.ticket_url ? (
                            // A quiet action: emerald is the music's (Warm up), tickets leave the app.
                            <a
                                href={event.ticket_url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="btn btn-sm !rounded-full min-h-[36px] shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                                aria-label={`get tickets for ${event.artist_name} on ${weekday} ${date} (opens the ticket site)`}
                            >
                                get tickets
                                <ArrowRight size={12} />
                            </a>
                        ) : (
                            <span className="text-xs text-[var(--color-text-muted)]">no ticket link</span>
                        )}
                    </div>
                </div>
            </div>
        </article>
    );
};

const LiveConcertsSkeleton: React.FC = () => (
    <section aria-hidden="true">
        <div className="mb-4">
            <div className="h-5 w-44 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
        </div>
        <div className="flex gap-3 sm:gap-4 overflow-hidden hide-scrollbar pb-2">
            {Array.from({ length: 3 }).map((_, i) => (
                <div
                    key={i}
                    className="w-[85vw] max-w-[380px] sm:w-[340px] md:w-[380px] shrink-0 h-[157px] rounded-2xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none"
                />
            ))}
        </div>
    </section>
);

const LiveConcertsHeader: React.FC<{ stale?: boolean }> = ({ stale }) => (
    <div className="flex items-center justify-between gap-2 mb-4">
        <h2 id="live-concerts-heading" className="text-lg font-semibold text-[var(--color-text-secondary)] lowercase">
            favourites live near you
        </h2>
        {stale && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-warning)]">
                <AlertTriangle size={12} />
                may be out of date
            </span>
        )}
    </div>
);

export const LiveConcertsHubSection: React.FC = () => {
    const getAuthHeader = usePlayerStore(s => s.getAuthHeader);
    const concertsEnabled = usePlayerStore(s => s.concertsEnabled);
    const [data, setData] = useState<HubResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = React.useCallback(async (signal?: { cancelled: boolean }) => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/concerts/hub', { headers: getAuthHeader() });
            if (!res.ok) throw new Error(`status ${res.status}`);
            const json: HubResponse = await res.json();
            if (!signal?.cancelled) setData(json);
        } catch (e) {
            console.error('Failed to load live concerts', e);
            if (!signal?.cancelled) setError('could not load nearby shows. check your connection and try again.');
        } finally {
            if (!signal?.cancelled) setLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        if (!concertsEnabled) {
            setLoading(false);
            setData({ events: [], disabled: true });
            return;
        }
        const signal = { cancelled: false };
        void load(signal);
        return () => { signal.cancelled = true; };
    }, [concertsEnabled, load]);

    // Feature disabled → hide entirely (the toggle lives in settings).
    if (!concertsEnabled) return null;

    if (loading) return <LiveConcertsSkeleton />;

    if (error) {
        return (
            <section aria-labelledby="live-concerts-heading">
                <LiveConcertsHeader />
                <div
                    role="alert"
                    className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-[var(--color-error)] flex items-center justify-between gap-3"
                >
                    <span>{error}</span>
                    <button onClick={() => void load()} className="btn btn-ghost btn-sm shrink-0">
                        retry
                    </button>
                </div>
            </section>
        );
    }

    if (!data || data.events.length === 0) {
        return (
            <section aria-labelledby="live-concerts-heading">
                <LiveConcertsHeader />
                <p className="text-sm text-[var(--color-text-muted)]">
                    no upcoming shows from your favourite artists nearby. set your location in settings → live music to widen the search.
                </p>
            </section>
        );
    }

    return (
        <section aria-labelledby="live-concerts-heading">
            <LiveConcertsHeader stale={data.stale} />
            <HorizontalScrollRail
                ariaLabel="favourites live near you"
                role="list"
                viewportClassName="
                    flex gap-3 sm:gap-4
                    overflow-x-auto hide-scrollbar
                    snap-x snap-mandatory
                    hub-scroll-mobile hub-scroll-live
                    pb-2
                "
            >
                {data.events.map(event => (
                    <div role="listitem" key={event.jambase_event_id}>
                        <TicketCard event={event} />
                    </div>
                ))}
            </HorizontalScrollRail>
        </section>
    );
};
