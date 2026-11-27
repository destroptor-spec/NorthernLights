/**
 * Dates and times for shows, written the way they are where the server runs:
 * the server's IANA time zone picks the convention (24-hour and "Fri 5 Mar"
 * in Europe and most of the world; 12-hour and "Fri, Mar 5" in the Americas,
 * Australia, New Zealand, India and the Philippines). The values themselves
 * are the venue's wall clock as JamBase gives it, never shifted.
 */
export function showLocale(timeZone: string | null | undefined): string {
  const tz = timeZone || '';
  if (/^(America|US|Canada)\//.test(tz)) return 'en-US';
  if (/^Australia\//.test(tz)) return 'en-AU';
  if (tz === 'Pacific/Auckland') return 'en-NZ';
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'en-IN';
  if (tz === 'Asia/Manila') return 'en-PH';
  return 'en-GB';
}

export interface ShowDate {
  /** "Fri 5 Mar" */
  dayAndDate: string;
  /** "5 Mar", for when the day is already named ("Tonight", "This Friday"). */
  date: string;
  /** "20:00" / "8:00 PM"; null when the show has no start time. */
  time: string | null;
}

export interface ShowDateParts {
  /** "Fri" */
  weekday: string;
  /** "5" */
  day: string;
  /** "Mar" */
  month: string;
  time: string | null;
}

/** The pieces for a calendar-style date block, in the server's convention. */
export function showDateParts(eventDate: string, eventDateTime: string | null, timeZone: string | null | undefined): ShowDateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate);
  if (!m) return { weekday: '', day: eventDate.slice(0, 10) || '--', month: '', time: null };
  const locale = showLocale(timeZone);
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(at);
  return {
    weekday: part({ weekday: 'short' }),
    day: part({ day: 'numeric' }),
    month: part({ month: 'short' }),
    time: formatShowDate(eventDate, eventDateTime, timeZone).time,
  };
}

export function formatShowDate(eventDate: string, eventDateTime: string | null, timeZone: string | null | undefined): ShowDate {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate);
  if (!day) return { dayAndDate: eventDate, date: eventDate, time: null };
  const locale = showLocale(timeZone);
  // The wall clock as if it were UTC, formatted in UTC: no shift anywhere.
  const at = (h = 0, m = 0) => new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), h, m));
  const utc = { timeZone: 'UTC' } as const;
  const dayAndDate = new Intl.DateTimeFormat(locale, { ...utc, weekday: 'short', day: 'numeric', month: 'short' }).format(at());
  const date = new Intl.DateTimeFormat(locale, { ...utc, day: 'numeric', month: 'short' }).format(at());
  let time: string | null = null;
  const clock = eventDateTime ? /T(\d{2}):(\d{2})/.exec(eventDateTime) : null;
  if (clock && !(clock[1] === '00' && clock[2] === '00')) {
    time = new Intl.DateTimeFormat(locale, { ...utc, hour: 'numeric', minute: '2-digit' }).format(at(Number(clock[1]), Number(clock[2])));
  }
  return { dayAndDate, date, time };
}
