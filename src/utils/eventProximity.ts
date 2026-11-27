/**
 * How soon an event is, in plain words for a concert card, in sentence case
 * like the rest of the card's date line: "Tonight" (or "Today" for a show
 * that starts before 5 pm), "Tomorrow", "This Saturday", "In 9 days". Null past four weeks, for a date already gone, or for a date it
 * can't read. Counted in calendar days on the listener's own calendar, from
 * the event's date (venue-local, as JamBase gives it).
 */
export function eventProximity(eventDate: string, eventDateTime: string | null, now: Date = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate);
  if (!m) return null;
  const event = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((event.getTime() - today.getTime()) / 86_400_000);
  if (days < 0 || days > 28) return null;
  if (days === 0) {
    const hour = eventDateTime && eventDateTime.length > 12 ? Number(eventDateTime.slice(11, 13)) : NaN;
    return Number.isFinite(hour) && hour > 0 && hour < 17 ? 'Today' : 'Tonight';
  }
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `This ${event.toLocaleDateString('en-GB', { weekday: 'long' })}`;
  return `In ${days} days`;
}
