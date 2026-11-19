const CENTRAL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
});

/** A stored UTC timestamp as US Central time for reading ("2026-11-18 04:17 CST"; CDT in summer). Stored values stay
 *  UTC. "" for a blank or unreadable value. */
export function centralTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const moment = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(moment.getTime())) return "";
  const part = Object.fromEntries(CENTRAL.formatToParts(moment).map((item) => [item.type, item.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${part.timeZoneName}`;
}
