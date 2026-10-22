// Toast rules (README "Toasts"): copies collapse, few show at once, a page change clears what
// the last page said, and a toast raised while a sheet is open shows in that sheet, never over it.
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_MS,
  MAX_TOASTS,
  TOAST_MS,
  addToast,
  afterRouteChange,
  afterSheetClosed,
  afterSheetOpened,
  clearTopic,
  type ToastItem,
} from "../src/components/ui/toast";

let nextId = 0;
const item = (message: string, change: Partial<ToastItem> = {}): ToastItem =>
  ({ id: ++nextId, tone: "success", message, at: 0, sheet: null, ...change });
const messages = (items: readonly ToastItem[]) => items.map((entry) => entry.message);

describe("toast queue", () => {
  it("keeps the documented reading time", () => {
    // a11y.spec.ts checks a toast stays at least ten seconds; placement, not speed, keeps them clear.
    expect(TOAST_MS).toBe(10_000);
  });

  it("collapses the same words into one toast, the newest", () => {
    const first = item("Version 1 is live again.");
    const again = item("Version 1 is live again.", { at: 400 });
    const items = addToast(addToast([], first), again);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(again.id);
    // Same words in another tone are another message.
    expect(addToast(items, item("Version 1 is live again.", { tone: "info" }))).toHaveLength(2);
  });

  it("shows at most a few, dropping the oldest that would close by itself first", () => {
    const error = item("Could not copy. Select the link and copy it by hand.", { tone: "danger" });
    let items = addToast([], error);
    for (const message of ["Moved to Deposit.", "Moved to Design.", "Moved to Delivered."]) items = addToast(items, item(message));
    expect(items).toHaveLength(MAX_TOASTS);
    // The error stays until dismissed: it is not pushed out by newer good news.
    expect(messages(items)).toEqual([error.message, "Moved to Delivered."]);
  });

  it("replaces an earlier toast on the same topic, so two answers never disagree", () => {
    let items = addToast([], item("Your site shows the live version now.", { topic: "site" }));
    items = addToast(items, item("Moved to Deposit."));
    items = addToast(items, item("Version 1 is live again.", { topic: "site" }));
    expect(messages(items)).toEqual(["Moved to Deposit.", "Version 1 is live again."]);
    expect(messages(clearTopic(items, "site"))).toEqual(["Moved to Deposit."]);
  });

  it("clears on a page change, except a toast raised for the move itself", () => {
    const old = item("Settings saved.", { at: 1_000 });
    const error = item("Could not copy. Select the link and copy it by hand.", { tone: "danger", at: 1_000 });
    const move = item("Added Teo Marsh.", { at: 20_000 });
    const now = 20_000 + ARRIVAL_MS - 1;
    expect(messages(afterRouteChange([old, error, move], now))).toEqual(["Added Teo Marsh."]);
    expect(afterRouteChange([move], 20_000 + ARRIVAL_MS)).toEqual([]);
  });

  it("keeps toasts off an open sheet: page toasts that close by themselves go, sheet toasts stay in it", () => {
    const page = item("Moved to Deposit.");
    const error = item("Could not copy. Select the link and copy it by hand.", { tone: "danger" });
    expect(messages(afterSheetOpened([page, error]))).toEqual([error.message]);
    const inSheet = item("Published. Your site is live.", { sheet: "editor" });
    // A toast raised as the sheet closes (publish answered, sheet shut) moves to the page.
    const closed = afterSheetClosed([error, inSheet], "editor", null);
    expect(closed.map((entry) => entry.sheet)).toEqual([null, null]);
    // Nested: it moves to the sheet below instead.
    expect(afterSheetClosed([inSheet], "editor", "history")[0]!.sheet).toBe("history");
  });

  it("counts the cap per place, so a sheet's toast never pushes out the page's error", () => {
    const error = item("Could not copy. Select the link and copy it by hand.", { tone: "danger" });
    let items = addToast([], error);
    items = addToast(items, item("That time was just taken.", { sheet: "booking", tone: "info" }));
    items = addToast(items, item("Booked Thu, Oct 22 at 11:00 AM.", { sheet: "booking" }));
    items = addToast(items, item("Booked Thu, Oct 22 at 2:00 PM.", { sheet: "booking" }));
    expect(items.filter((entry) => entry.sheet === null)).toEqual([error]);
    expect(items.filter((entry) => entry.sheet === "booking")).toHaveLength(MAX_TOASTS);
  });
});
