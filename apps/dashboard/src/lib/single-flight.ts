/**
 * A guard for a write a person starts with a tap. A second tap can land before React renders the
 * button as busy, so `disabled={isPending}` alone lets it through and every answer toasts twice.
 * The guard runs a task only while none is in flight, and says whether it ran this one. A task's
 * failure frees the guard and is left to the mutation's own error state.
 */
export function singleFlight(): (task: () => Promise<unknown>) => boolean {
  let busy = false;
  return (task) => {
    if (busy) return false;
    busy = true;
    void task().catch(() => undefined).finally(() => {
      busy = false;
    });
    return true;
  };
}
