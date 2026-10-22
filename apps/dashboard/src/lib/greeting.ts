import { zonedParts } from "./time";

/**
 * Home's greeting at `now` in `zone`, with the person's name only when one is known
 * (members have no display name yet). Before the clock is read: "Hello."
 */
export function greetingLine(now: number | null, zone: string, name?: string | null): string {
  const to = name ? `, ${name}` : "";
  if (now === null) return `Hello${to}.`;
  const hour = Math.floor(zonedParts(now, zone).minute / 60);
  return `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${to}.`;
}
