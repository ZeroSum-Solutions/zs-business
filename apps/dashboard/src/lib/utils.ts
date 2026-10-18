import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(amount: number, currency = "USD", fractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: fractionDigits, minimumFractionDigits: fractionDigits }).format(amount);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Percentage change from last week, rounded to a whole number. Null when last week was zero. */
export function weekChange(thisWeek: number, lastWeek: number): number | null {
  if (lastWeek === 0) return null;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "")).toUpperCase();
}

export function formatPhone(phone: string | null): string | null {
  if (!phone) return null;
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `+1 ${match[1]} ${match[2]} ${match[3]}` : phone;
}

/**
 * Focus handler for chips in a horizontal scroller. Chrome leaves a half-visible chip where it
 * is on focus, which cuts off its focus ring; this brings it fully in, honouring scroll-padding.
 */
export function revealOnFocus(event: { currentTarget: HTMLElement }) {
  event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
}
