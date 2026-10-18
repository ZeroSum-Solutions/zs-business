import { ErrorNote } from "@/components/ui/states";
import { CALENDAR_UNAVAILABLE, isApiError } from "@/lib/api";

/** A failed slot read. A 403 will not change on retry: this account cannot use the calendar. */
export function SlotsError({ error, retry }: { error: unknown; retry: () => void }) {
  return isApiError(error, "forbidden")
    ? <ErrorNote error={error} message={CALENDAR_UNAVAILABLE} />
    : <ErrorNote error={error} retry={retry} />;
}
