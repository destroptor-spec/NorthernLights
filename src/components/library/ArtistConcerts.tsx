import React, { useEffect, useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { Ticket, MapPin, ArrowRight, AlertTriangle } from 'lucide-react';
import { HorizontalScrollRail } from '../HorizontalScrollRail';
import { showDateParts } from '../../utils/showDateFormat';

export type ArtistEvent = {
    jambase_event_id: string;
    artist_id: string;
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

type ArtistConcertsResp = {
    events: ArtistEvent[];
    refreshed: boolean;
    stale: boolean;
    onTour: boolean;
    disabled?: boolean;
    lastFetchedAt: string | null;
    /** The server's IANA time zone: show dates are written its way. */
    timeZone?: string;
};

export function useArtistConcerts(artistId: string | undefined): {
    loading: boolean;
    onTour: boolean;
    events: ArtistEvent[];
    stale: boolean;
    disabled: boolean;
    timeZone?: string;
} {
    const getAuthHeader = usePlayerStore(s => s.getAuthHeader);
    const [state, setState] = useState<ArtistConcertsResp | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!artistId) return;
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await fetch(`/api/concerts/artist/${artistId}`, { headers: getAuthHeader() });
                if (res.ok) {
                    const data: ArtistConcertsResp = await res.json();
                    if (!cancelled) setState(data);
                }
            } catch {} finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [artistId, getAuthHeader]);

    return {
        loading,
        onTour: !!state?.onTour,
        events: state?.events || [],
        stale: !!state?.stale,
        disabled: !!state?.disabled,
        timeZone: state?.timeZone,
    };
}

export const OnTourSticker: React.FC<{ visible: boolean }> = ({ visible }) => {
    if (!visible) return null;
    return (
        <span
            className="
                inline-flex items-center gap-1.5
                px-3 py-1
                rounded-full
                text-[11px] font-bold uppercase tracking-[0.12em]
                text-white
                bg-[var(--color-accent)]
                shadow-[0_2px_8px_rgba(244,63,94,0.35)]
                animate-[pulse_3s_ease-in-out_infinite]
            "
            role="status"
            aria-label="Artist is currently on tour"
        >
            <Ticket size={12} className="flex-shrink-0" strokeWidth={2.5} />
            On tour
        </span>
    );
};

function formatPrice(min: number | null, max: number | null, currency: string | null): string | null {
    if (min == null && max == null) return null;
    const cur = (currency || 'USD').toUpperCase();
    const symbol = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'NOK' ? 'kr ' : `${cur} `;
    if (min != null && max != null && max > min) return `${symbol}${Math.round(min)}–${Math.round(max)}`;
    return `from ${symbol}${Math.round((min ?? max)!)}`;
}

const MiniEventCard: React.FC<{ event: ArtistEvent; timeZone?: string }> = ({ event, timeZone }) => {
    const { weekday, month, day, time } = showDateParts(event.event_date, event.event_datetime, timeZone);
    const price = formatPrice(event.price_min, event.price_max, event.price_currency);
    const locality = [event.venue_city, event.venue_region || event.venue_country].filter(Boolean).join(', ');

    return (
        <div className="
            relative flex min-h-[96px] items-stretch gap-2.5 md:gap-3
            bg-[var(--color-surface)]
            rounded-xl
            p-2.5 md:p-3
            hover:bg-[var(--color-surface-hover)]
            transition-ui
        ">
            {/* Date block — calendar/poster style */}
            <div className="
                flex flex-col items-center justify-center
                shrink-0 w-14 md:w-16
                bg-[var(--color-surface-variant)]
                rounded-lg
                py-2 px-1
                text-center
            ">
                <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-primary-fill)]">
                    {weekday}
                </span>
                <span className="text-2xl font-bold text-[var(--color-text-primary)] tabular-nums leading-none mt-0.5">
                    {day}
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mt-0.5">
                    {month}
                </span>
            </div>

            {/* Body */}
            <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                {event.venue_name && (
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)] line-clamp-1 leading-snug">
                        {event.venue_name}
                    </h3>
                )}
                {locality && (
                    <div className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                        <MapPin size={11} className="flex-shrink-0" />
                        <span className="line-clamp-1">{locality}</span>
                    </div>
                )}
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mt-0.5">
                    {time && (
                        <span className="hidden md:inline tabular-nums">{time}</span>
                    )}
                    {price && (
                        <>
                            {time && <span className="hidden md:inline" aria-hidden="true">·</span>}
                            <span className="tabular-nums">{price}</span>
                        </>
                    )}
                </div>
            </div>

            {/* CTA */}
            {event.ticket_url && (
                <a
                    href={event.ticket_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="
                        self-center flex items-center justify-center
                        min-h-[44px] min-w-[44px] px-3
                        rounded-full
                        text-[var(--color-primary-fill)] hover:text-[var(--color-on-primary)]
                        bg-primary/10 hover:bg-[var(--color-primary-fill)]
                        transition-colors
                        flex-shrink-0
                    "
                    aria-label={`Get tickets for ${weekday} ${day} ${month}`}
                >
                    <ArrowRight size={16} />
                </a>
            )}
        </div>
    );
};

interface UpcomingShowsProps {
    events: ArtistEvent[];
    loading: boolean;
    stale: boolean;
    timeZone?: string;
}

export const UpcomingShows: React.FC<UpcomingShowsProps> = ({ events, loading, stale, timeZone }) => {
    if (loading) {
        return (
            <section className="mb-12">
                <div className="flex items-center justify-between gap-4 mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                    <h2 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] flex items-center gap-2">
                        Upcoming shows
                    </h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1 snap-x snap-mandatory hide-scrollbar">
                    {[0, 1, 2].map(i => (
                        <div
                            key={i}
                            className="h-[96px] min-w-[78vw] snap-start rounded-xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none md:min-w-[calc((100%-1.5rem)/3)]"
                        />
                    ))}
                </div>
            </section>
        );
    }

    if (events.length === 0) return null;
    const visible = events.slice(0, 5);

    return (
        <section className="mb-12">
            <div className="flex items-center justify-between gap-4 mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                <h2 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] flex items-center gap-2">
                    Upcoming shows
                    <span className="text-xs font-normal text-[var(--color-text-muted)] ml-1 tabular-nums">
                        ({events.length})
                    </span>
                </h2>
                {stale && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={12} />
                        May be out of date
                    </span>
                )}
            </div>
            <HorizontalScrollRail
                ariaLabel="Upcoming shows"
                viewportClassName="flex gap-3 overflow-x-auto pb-1 snap-x snap-mandatory"
            >
                {visible.map(e => (
                    <div key={e.jambase_event_id} className="min-w-[78vw] snap-start md:min-w-[calc((100%-1.5rem)/3)]">
                        <MiniEventCard event={e} timeZone={timeZone} />
                    </div>
                ))}
            </HorizontalScrollRail>
        </section>
    );
};
