"use client";

import { ArrowsClockwise, ArrowSquareOut, CalendarCheck, CheckCircle, Clock, Info, LinkBreak, MinusCircle, PlugsConnected, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { CalendarConnection, PendingGoogleConnect, ResourceSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import {
  busyTimesChanged,
  CANCELLED_MESSAGE,
  confirmErrorNotice,
  isGrantChanged,
  CONNECTED_MESSAGE,
  connectErrorMessage,
  currentConnection,
  disconnectingStatus,
  GOOGLE_ACCESS_URL,
  MANAGE_CALENDARS,
  syncErrorMessage,
  type ReturnNotice,
} from "@/lib/calendar-sync";
import { newId } from "@/lib/id";
import { useIntentKey } from "@/lib/intent-key";
import { useCalendarConnections, useKeys, usePendingGoogleConnect, useResources } from "@/lib/queries";
import { useCan } from "@/lib/session";
import { cn, relativeTime } from "@/lib/utils";

type RowState = "none" | CalendarConnection["status"];

const STATE: Record<Exclude<RowState, "disconnected">, { label: string; tone: "success" | "warn" | "neutral"; icon: typeof CheckCircle }> = {
  none: { label: "Not connected", tone: "neutral", icon: MinusCircle },
  active: { label: "Connected", tone: "success", icon: CheckCircle },
  reauthorize: { label: "Reconnect needed", tone: "warn", icon: WarningCircle },
  disconnecting: { label: "Disconnecting", tone: "neutral", icon: Clock },
};

const OWNER_ONLY_ID = "calendar-owner-only";

/**
 * Google Calendar busy sync per booking calendar (google-calendar.md G-1, G-2, G-5): live data,
 * owners connect and disconnect, staff see the status. A grant Google gave waits until the owner
 * confirms its account here. `notice` is what Google's return or that confirmation said.
 */
export function GoogleCalendarCard({ notice, onNotice }: { notice: ReturnNotice | null; onNotice: (notice: ReturnNotice | null) => void }) {
  const resources = useResources();
  const connections = useCalendarConnections();
  const canManage = useCan(MANAGE_CALENDARS);
  const pending = usePendingGoogleConnect(canManage);
  useSlotsRefresh(connections.data);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Bumped when the confirm panel closes, so focus lands on what it said rather than the page.
  const [focusNotice, setFocusNotice] = useState(0);
  useEffect(() => {
    if (focusNotice > 0) noticeRef.current?.focus();
  }, [focusNotice]);
  const finish = useCallback((next: ReturnNotice) => {
    onNotice(next);
    setFocusNotice((count) => count + 1);
  }, [onNotice]);
  // Asked once the calendars are known, so the question names the right one.
  const pendingName = pending.data && resources.data
    ? resources.data.find((resource) => resource.id === pending.data!.resourceId)?.name ?? "this booking calendar"
    : null;

  return (
    <Card aria-labelledby="gcal-title" data-testid="gcal-card" className="mb-6">
      <CardHeader className="mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarCheck size={20} aria-hidden className="text-muted" />
            <CardTitle id="gcal-title">Google Calendar</CardTitle>
          </div>
          <CardDescription className="mt-1">
            Busy times in a connected Google Calendar block that calendar&apos;s open slots, and new bookings are added to it.
          </CardDescription>
        </div>
      </CardHeader>
      {pending.data && pendingName ? <ConfirmGrant key={pending.data.grantId} pending={pending.data} resourceName={pendingName} onDone={finish} /> : null}
      {pending.isError ? <div className="mb-4"><ErrorNote error={pending.error} retry={() => pending.refetch()} /></div> : null}
      {notice ? (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.tone === "error" ? "alert" : "status"}
          data-testid="gcal-return"
          className={cn(
            "mb-4 flex items-start gap-3 rounded-md p-3 text-sm text-fg-2 outline-none",
            notice.tone === "success" ? "bg-success/10" : notice.tone === "info" ? "bg-surface-warm" : "bg-danger/8",
          )}
        >
          {notice.tone === "success" ? <CheckCircle size={20} aria-hidden className="mt-px shrink-0 text-success" />
            : notice.tone === "info" ? <Info size={20} aria-hidden className="mt-px shrink-0 text-muted" />
            : <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-danger" />}
          <p>{notice.message}</p>
        </div>
      ) : null}
      {canManage ? null : <div className="mb-3"><DisabledReason id={OWNER_ONLY_ID}>Only an owner can connect or disconnect calendars.</DisabledReason></div>}
      {resources.isError ? <ErrorNote error={resources.error} retry={() => resources.refetch()} />
        : connections.isError ? <ErrorNote error={connections.error} retry={() => connections.refetch()} />
        : resources.isPending || connections.isPending ? <LoadingRows rows={2} label="Loading calendars" />
        : resources.data.length === 0 ? (
        <EmptyState title="No booking calendars yet">Add a booking calendar first, then connect it to Google here.</EmptyState>
      ) : (
        <ul className="-mx-4 divide-y divide-border-soft border-t border-border-soft lg:-mx-6" aria-label="Booking calendars">
          {resources.data.map((resource) => (
            <CalendarRow key={resource.id} resource={resource} connection={currentConnection(connections.data, resource.id)} canManage={canManage} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Busy times change which slots are open: read them again when a sync or a status change lands. */
function useSlotsRefresh(items: readonly CalendarConnection[] | undefined) {
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const previous = useRef(items);
  useEffect(() => {
    const before = previous.current;
    previous.current = items;
    if (before && items && before !== items && busyTimesChanged(before, items)) void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
  }, [items, queryClient, keys]);
}

/**
 * The grant Google gave this browser, waiting for the owner to say it is their account (G-2). A
 * link someone else sent could have brought their account here, so nothing connects until the
 * owner confirms. The server answers the confirm for good once and then drops the grant.
 */
function ConfirmGrant({ pending, resourceName, onDone }: { pending: PendingGoogleConnect; resourceName: string; onDone: (notice: ReturnNotice) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const account = pending.accountEmail ?? "this Google account";

  const settled = (notice: ReturnNotice) => {
    queryClient.setQueryData(keys.calendarPending, null);
    onDone(notice);
  };

  // No key from here: the server keys the confirm by the grant, so a retry replays it.
  const confirm = useMutation({
    mutationFn: () => api.confirmGoogleConnect(pending.grantId),
    onSuccess: () => settled({ tone: "success", message: CONNECTED_MESSAGE }),
    onError: (error) => {
      const notice = confirmErrorNotice(error);
      // Another grant replaced this one: nothing connected, and the re-read below shows the new
      // grant in a fresh panel for the owner to check.
      if (notice && isGrantChanged(error)) onDone(notice);
      // A lost answer leaves the grant waiting: the panel stays, with the error, for a retry.
      else if (notice) settled(notice);
    },
    onSettled: async () => {
      // Read both again after every answer: a lost one may still have connected.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.calendarPending }),
        queryClient.invalidateQueries({ queryKey: keys.calendarConnections }),
      ]);
    },
  });

  const discard = useMutation({
    mutationFn: () => api.discardGoogleConnect(),
    onSuccess: () => settled({ tone: "info", message: CANCELLED_MESSAGE }),
  });

  const busy = confirm.isPending || discard.isPending;
  const error = confirm.isError ? confirm.error : discard.isError ? discard.error : null;

  return (
    <div
      role="region"
      aria-labelledby="gcal-confirm-label"
      aria-describedby="gcal-confirm-hint"
      data-testid="gcal-confirm"
      className="mb-4 rounded-md bg-surface-warm p-4"
    >
      <p id="gcal-confirm-label" className="text-xs font-medium text-meta">Confirm Google account</p>
      <h3 className="mt-1 text-sm font-semibold break-words text-fg" data-testid="gcal-confirm-question">Connect {account} to {resourceName}?</h3>
      <p id="gcal-confirm-hint" className="mt-1 text-sm text-fg-2">
        Check that this is your Google account. If you did not just connect a calendar, choose Cancel.
      </p>
      {error ? <div className="mt-3"><ErrorNote error={error} /></div> : null}
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={() => discard.mutate()} disabled={busy} aria-busy={discard.isPending}>
          {discard.isPending ? "Cancelling…" : "Cancel"}
        </Button>
        <Button onClick={() => confirm.mutate()} disabled={busy} aria-busy={confirm.isPending}>
          <PlugsConnected aria-hidden />{confirm.isPending ? "Connecting…" : "Connect calendar"}
        </Button>
      </div>
    </div>
  );
}

function CalendarRow({ resource, connection, canManage }: { resource: ResourceSummary; connection: CalendarConnection | null; canManage: boolean }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const disconnectKeys = useIntentKey();
  // The connection the disconnect dialog was opened for. It shows only while that connection is
  // still the live one, so a later connection never opens with the dialog up.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Set once the browser is on its way to Google, so the button stays busy until the page goes.
  const [leaving, setLeaving] = useState(false);

  // Back from Google through the browser's back button, the page may come from its cache as it was.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const state: RowState = connection?.status ?? "none";
  const liveId = connection && (connection.status === "active" || connection.status === "reauthorize") ? connection.id : null;
  const confirming = confirmingId !== null && confirmingId === liveId;
  const shown = STATE[state === "disconnected" ? "none" : state];
  const leavingStatus = connection?.status === "disconnecting" ? disconnectingStatus(connection.lastError) : null;
  const rowId = `gcal-${resource.id}`;
  const errorId = `${rowId}-error`;

  // A connect writes nothing (G-1), so every click takes a fresh key: reusing one after the
  // connection it named was retired would only meet a 409.
  const connect = useMutation({
    mutationFn: () => api.startGoogleConnect(resource.id, { idempotencyKey: newId() }),
    onSuccess: ({ authorizeUrl }) => {
      const target = new URL(authorizeUrl, window.location.href);
      // The demo answers with this page itself (to confirm the account); a client-side move keeps its in-memory data.
      if (target.origin === window.location.origin) {
        router.push(`${target.pathname}${target.search}`);
        return;
      }
      setLeaving(true);
      window.location.assign(authorizeUrl);
    },
  });

  const disconnect = useMutation({
    mutationFn: (connectionId: string) => api.disconnectCalendar(connectionId, { idempotencyKey: disconnectKeys.keyFor(connectionId) }),
    onSettled: async (_result, error, connectionId) => {
      // A lost answer keeps the key, so a retry replays the first attempt instead of a second one.
      disconnectKeys.settle(connectionId, error);
      // Read the list again after every answer, a lost one too: it says what happened.
      await queryClient.invalidateQueries({ queryKey: keys.calendarConnections });
    },
    onSuccess: (result) => {
      queryClient.setQueryData<CalendarConnection[]>(keys.calendarConnections, (items) => items?.map((item) => (item.id === result.id ? result : item)));
      setConfirmingId(null);
      toast(`Disconnecting ${resource.name}. Busy times from Google stop blocking its slots in a moment.`, "info");
    },
  });

  const connecting = connect.isPending || leaving;
  const ownerOnly = canManage ? undefined : OWNER_ONLY_ID;
  const describedBy = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;
  const connectError = connect.isError ? connectErrorMessage(connect.error) : null;

  return (
    <li aria-labelledby={`${rowId}-name`} data-testid="gcal-row" className="flex flex-wrap items-start gap-3 px-4 py-4 sm:flex-nowrap lg:px-6">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${rowId}-name`} className="text-sm font-semibold">{resource.name}</h3>
          <Badge tone={shown.tone} data-testid="gcal-status"><shown.icon aria-hidden />{shown.label}</Badge>
        </div>
        {connection?.status === "active" ? (
          <>
            <p className="text-sm break-words text-fg-2" data-testid="gcal-account">{connection.accountEmail ?? "Google account"}</p>
            <p className="text-xs text-meta" data-testid="gcal-synced">
              {connection.lastSyncedAt ? `Last synced ${relativeTime(connection.lastSyncedAt).toLowerCase()}` : "Waiting for the first sync"}
            </p>
            {connection.lastError ? <Warning>{syncErrorMessage(connection.lastError)}</Warning> : null}
          </>
        ) : connection?.status === "reauthorize" ? (
          <Warning>Google access ended. Busy times already read still block slots until you reconnect or disconnect.</Warning>
        ) : leavingStatus?.stuck ? (
          <>
            <Warning>{leavingStatus.message}</Warning>
            {canManage ? <p className="text-xs text-meta" data-testid="gcal-recovery">To end it now, remove Zero Sum from your Google account&apos;s third-party access.</p> : null}
          </>
        ) : leavingStatus ? (
          <p className="text-xs text-meta">{leavingStatus.message}</p>
        ) : (
          <p className="text-xs text-meta">Not syncing with Google.</p>
        )}
        {connectError ? <p id={errorId} role="alert" className="text-sm text-danger" data-testid="gcal-connect-error">{connectError}</p> : null}
      </div>
      {state === "disconnecting" ? (
        leavingStatus?.stuck && canManage ? (
          <div className="flex w-full sm:w-auto sm:justify-end">
            <Button asChild variant="secondary">
              <a href={GOOGLE_ACCESS_URL} target="_blank" rel="noreferrer noopener">
                <ArrowSquareOut aria-hidden />Google account access<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          </div>
        ) : null
      ) : (
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap sm:justify-end">
          {state === "active" ? null : (
            <Button
              variant={state === "reauthorize" ? "primary" : "secondary"}
              onClick={() => connect.mutate()}
              disabled={!canManage || connecting}
              aria-busy={connecting}
              aria-describedby={describedBy(ownerOnly, connectError ? errorId : undefined)}
            >
              {state === "reauthorize" ? <ArrowsClockwise aria-hidden /> : <PlugsConnected aria-hidden />}
              {connecting ? "Opening Google…" : state === "reauthorize" ? "Reconnect" : "Connect"}
              <span className="sr-only"> {resource.name}</span>
            </Button>
          )}
          {connection && (state === "active" || state === "reauthorize") ? (
            <Button
              variant="danger-outline"
              onClick={() => {
                disconnect.reset();
                setConfirmingId(connection.id);
              }}
              disabled={!canManage}
              aria-describedby={ownerOnly}
            >
              <LinkBreak aria-hidden />Disconnect<span className="sr-only"> {resource.name}</span>
            </Button>
          ) : null}
        </div>
      )}
      {connection ? (
        <Dialog open={confirming} onOpenChange={(open) => { if (!disconnect.isPending) setConfirmingId(open ? liveId : null); }}>
          {confirming ? (
            <DialogContent title="Disconnect Google Calendar?" description={`${resource.name} stops syncing with ${connection.accountEmail ?? "Google"}.`}>
              <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-fg-2">
                <li>Busy times from Google stop blocking this calendar&apos;s open slots.</li>
                <li>Events already added to Google stay in Google.</li>
                <li>New bookings are no longer added to Google.</li>
              </ul>
              {disconnect.isError ? <div className="mb-4"><ErrorNote error={disconnect.error} /></div> : null}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <DialogClose asChild><Button variant="ghost" disabled={disconnect.isPending}>Keep connected</Button></DialogClose>
                <Button variant="danger" onClick={() => disconnect.mutate(connection.id)} disabled={disconnect.isPending} aria-busy={disconnect.isPending}>
                  {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </DialogContent>
          ) : null}
        </Dialog>
      ) : null}
    </li>
  );
}

function Warning({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-fg-2" data-testid="gcal-warning">
      <WarningCircle size={16} aria-hidden className="mt-px shrink-0 text-warn" />
      <span>{children}</span>
    </p>
  );
}
