"use client";

import { ArrowsClockwise, CheckCircle, Clock, Info, Plug, Plugs, Storefront, WarningCircle, X } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CONNECTION_RETENTION_LINE, READ_SCOPE_DISCLOSURES, connectionToolkit } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, type ManagedConnection, type PendingManagedConnection } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import type { ReturnNotice } from "@/lib/calendar-sync";
import { useIntentKey } from "@/lib/intent-key";
import {
  CONNECTED_MESSAGE,
  DISCONNECT_AGENTS,
  DISCONNECT_TITLE,
  DISCONNECT_WHAT,
  MANAGE_MANAGED_CONNECTIONS,
  PENDING_TIMEOUT_MESSAGE,
  RECONNECT_TITLE,
  RECONNECT_WHAT,
  READ_BLOCKED_MESSAGE,
  REVOKE_FAILED_MESSAGE,
  SHOP_DOMAIN_HELP,
  STAFF_ERROR,
  STILL_WAITING_MESSAGE,
  DisconnectPendingError,
  RECONNECT_NATIVE_CONFIRM,
  RECONNECT_NATIVE_NEXT,
  RECONNECT_NATIVE_WHAT,
  disconnectForNativeInstall,
  reconnectPath,
  cancelNotice,
  confirmErrorNotice,
  connectErrorMessage,
  currentConnections,
  isGrantChanged,
  parseShopDomain,
  pollConnectStatus,
  reauthorizeMessage,
  reconnectStore,
  returnNotice,
} from "@/lib/managed-connections";
import { useKeys, useManagedConnections, usePendingManagedConnect } from "@/lib/queries";
import { useCan } from "@/lib/session";
import { ShopifyClaim, useNativeShopify, type NativeShopify } from "./shopify-claim";
import { cn, relativeTime } from "@/lib/utils";

const TOOLKIT = "shopify";
const OWNER_ONLY_ID = "shopify-owner-only";

const STATE: Record<ManagedConnection["status"], { label: string; tone: "success" | "warn" | "neutral"; icon: typeof CheckCircle }> = {
  active: { label: "Connected", tone: "success", icon: CheckCircle },
  reauthorize: { label: "Reconnect needed", tone: "warn", icon: WarningCircle },
  disconnecting: { label: "Disconnecting", tone: "neutral", icon: Clock },
  disconnected: { label: "Disconnected", tone: "neutral", icon: Clock },
};

/** Sends the browser to the provider's page. The demo answers with this page itself, so it moves client-side. */
function useLeave() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  // Back from the provider through the browser's back button, the page may come from its cache as it was.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  const go = useCallback((authorizeUrl: string) => {
    const target = new URL(authorizeUrl, window.location.href);
    if (target.origin === window.location.origin) {
      router.push(`${target.pathname}${target.search}`);
      return;
    }
    setLeaving(true);
    window.location.assign(authorizeUrl);
  }, [router]);
  return { leaving, go };
}

/**
 * Shopify as a managed-tier connection (connections.md C-4, C-5, C-13): live data, owners connect and
 * disconnect, staff see nothing to act on. A grant Shopify gave waits until the owner confirms the store
 * here. `notice` is what Shopify's return or the confirmation said; `waiting` is set while the provider has
 * not finished and the page asks again; `onSettled` ends that.
 */
export function ShopifyCard({ notice, onNotice, waiting, onSettled }: {
  notice: ReturnNotice | null;
  onNotice: (notice: ReturnNotice | null) => void;
  waiting: boolean;
  onSettled: () => void;
}) {
  const canManage = useCan(MANAGE_MANAGED_CONNECTIONS);
  const connections = useManagedConnections(canManage);
  const pending = usePendingManagedConnect(canManage);
  const noticeRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Bumped when the confirm panel closes, so focus lands on what it said rather than the page.
  const [focusNotice, setFocusNotice] = useState(0);
  useEffect(() => {
    if (focusNotice > 0) noticeRef.current?.focus();
  }, [focusNotice]);
  const finish = useCallback((next: ReturnNotice) => {
    onNotice(next);
    setFocusNotice((count) => count + 1);
  }, [onNotice]);
  const clearNotice = useCallback(() => onNotice(null), [onNotice]);
  useStatusPolling(waiting && canManage, onNotice, onSettled);

  const items = connections.data ? currentConnections(connections.data) : [];
  const hasLive = items.some((item) => item.status !== "disconnected");
  // A server without connections settings answers 404 for the list: Shopify is not offered at all.
  const notSetUp = connections.isError && isApiError(connections.error, "not_found");
  const { state: nativeState, retry: retryNative } = useNativeShopify(canManage);
  const native = nativeState === "native";
  // C-18: set once a legacy row is disconnected for the native install; the claim card then makes the link code by itself.
  const [relink, setRelink] = useState(false);

  return (
    <Card aria-labelledby="shopify-title" data-testid="shopify-card" className="mb-6">
      <CardHeader className="mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Storefront size={20} aria-hidden className="text-muted" />
            <CardTitle id="shopify-title" ref={titleRef} tabIndex={-1} className="outline-none">Shopify</CardTitle>
          </div>
          <CardDescription className="mt-1">
            Let your agents read orders from your Shopify store. They can read only; nothing in your store is changed.
          </CardDescription>
        </div>
      </CardHeader>
      {canManage && pending.data ? <ConfirmShop key={pending.data.grantId} pending={pending.data} onDone={finish} /> : null}
      {canManage && pending.isError && !notSetUp ? <div className="mb-4"><ErrorNote error={pending.error} retry={() => pending.refetch()} /></div> : null}
      {waiting && canManage ? (
        <p role="status" className="mb-4 flex items-center gap-2 text-sm text-fg-2" data-testid="shopify-waiting">
          <Clock size={16} aria-hidden className="shrink-0 text-muted" />{STILL_WAITING_MESSAGE}
        </p>
      ) : null}
      {notice ? (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={notice.tone === "error" ? "alert" : "status"}
          data-testid="shopify-return"
          className={cn(
            "mb-4 flex items-start gap-3 rounded-md p-3 text-sm text-fg-2 outline-none",
            notice.tone === "success" ? "bg-success-tint" : notice.tone === "info" ? "bg-inset" : "bg-danger-tint",
          )}
        >
          {notice.tone === "success" ? <CheckCircle size={20} aria-hidden className="mt-px shrink-0 text-success" />
            : notice.tone === "info" ? <Info size={20} aria-hidden className="mt-px shrink-0 text-muted" />
            : <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-danger" />}
          <p className="flex-1">{canManage || notice.tone !== "error" ? notice.message : STAFF_ERROR}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => { onNotice(null); titleRef.current?.focus(); }}
            className="-m-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-pill text-muted transition-quick hover:bg-inset hover:text-fg"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      ) : null}
      {canManage ? (
        notSetUp ? (
          <p className="text-sm text-fg-2" data-testid="shopify-not-set-up">Shopify connections are not set up on this server yet.</p>
        ) : connections.isError ? <ErrorNote error={connections.error} retry={() => connections.refetch()} />
        : connections.isPending ? <LoadingRows rows={1} label="Loading Shopify" />
        : (
          <>
            {items.length > 0 ? (
              <ul className="-mx-4 divide-y divide-border-soft border-y border-border-soft lg:-mx-6" aria-label="Shopify stores">
                {items.map((connection) => <ShopRow key={connection.id} connection={connection} nativeState={nativeState} onAction={clearNotice} onRelink={setRelink} />)}
              </ul>
            ) : null}
            {/* One live connection per toolkit (C-7): a retired store left in view for its warning does not count. */}
            {hasLive ? null : <ShopifyClaim autoStart={relink} onAutoStarted={() => setRelink(false)} />}
            {/* C-18, S1 2.3.1: with the native tier on, no screen asks for a shop domain; the store is installed from the Shopify App Store. */}
            {hasLive || nativeState === "pending" ? null : native ? <AppStoreNote /> : nativeState === "unknown" ? <NativeUnknownNote retry={retryNative} /> : <ConnectForm hasStores={items.length > 0} onAction={clearNotice} />}
          </>
        )
      ) : (
        <div className="mb-3"><DisabledReason id={OWNER_ONLY_ID}>Only an owner can connect or disconnect Shopify.</DisabledReason></div>
      )}
    </Card>
  );
}

/**
 * While the provider has not finished (the callback said "pending"), asks how the connect ended: at most
 * STATUS_POLLS times, STATUS_POLL_MS apart (connections.md C-5), the first ask after one wait (the callback was
 * the ask at 0 s). The whole wait is one
 * `pollConnectStatus` call started when `active` turns on, and the effect depends on `active` alone: what it
 * needs besides (the API, the cache, the callbacks) is read from a ref, so a rerender, which makes new `keys`
 * every time, cannot restart the wait or give it a new count.
 */
function useStatusPolling(active: boolean, onNotice: (notice: ReturnNotice | null) => void, onSettled: () => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const latest = useRef({ api, queryClient, keys, onNotice, onSettled });
  latest.current = { api, queryClient, keys, onNotice, onSettled };
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    const settle = (notice: ReturnNotice | null) => {
      if (stopped) return;
      latest.current.onNotice(notice);
      latest.current.onSettled();
    };
    void (async () => {
      try {
        const result = await pollConnectStatus(() => latest.current.api.checkManagedConnectStatus(), { stopped: () => stopped });
        if (result === "stopped") return;
        if (result === "timeout") {
          settle({ tone: "info", message: PENDING_TIMEOUT_MESSAGE });
          return;
        }
        const { queryClient: client, keys: scoped } = latest.current;
        await Promise.all([
          client.invalidateQueries({ queryKey: scoped.managedPending }),
          client.invalidateQueries({ queryKey: scoped.managedConnections }),
        ]);
        settle(returnNotice(result.connection, result.reason ?? null));
      } catch {
        settle(returnNotice("error", "unavailable"));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [active]);
}

/**
 * The grant Shopify gave this browser, waiting for the owner to say it is their store (C-5). A link
 * someone else sent could have brought their store here, so nothing connects until the owner confirms. The
 * server answers the confirm for good once and then drops the grant.
 */
function ConfirmShop({ pending, onDone }: { pending: PendingManagedConnection; onDone: (notice: ReturnNotice) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const scopes = connectionToolkit(pending.toolkit)?.providerScopes ?? [];

  const settled = (notice: ReturnNotice) => {
    queryClient.setQueryData(keys.managedPending, null);
    onDone(notice);
  };

  // No key from here: the server keys the confirm by the grant, so a retry replays it.
  const confirm = useMutation({
    mutationFn: () => api.confirmManagedConnect(pending.grantId),
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
        queryClient.invalidateQueries({ queryKey: keys.managedPending }),
        queryClient.invalidateQueries({ queryKey: keys.managedConnections }),
      ]);
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelManagedConnect(),
    // The account is removed at Shopify too; when that failed, the notice sends the owner to Shopify admin (C-5).
    onSuccess: (result) => settled(cancelNotice(result)),
  });

  const busy = confirm.isPending || cancel.isPending;
  const error = confirm.isError ? confirm.error : cancel.isError ? cancel.error : null;
  const tokens = pending.tokensWithAccess;

  return (
    <div
      role="region"
      aria-labelledby="shopify-confirm-label"
      aria-describedby="shopify-confirm-hint"
      data-testid="shopify-confirm"
      className="mb-4 rounded-md bg-inset p-4"
    >
      <p id="shopify-confirm-label" className="text-xs font-medium text-meta">Confirm Shopify store</p>
      <h3 className="mt-1 text-sm font-bold break-words text-fg" data-testid="shopify-confirm-question">
        Connect {pending.accountLabel} ({pending.shopDomain})?
      </h3>
      <p id="shopify-confirm-hint" className="mt-1 text-sm text-fg-2">
        Check that this is your store. If you did not just connect Shopify, choose Cancel.
      </p>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]" data-testid="shopify-confirm-facts">
        <dt className="text-meta">Store</dt>
        <dd className="min-w-0 break-words text-fg-2" data-testid="shopify-confirm-domain">{pending.shopDomain}</dd>
        <dt className="text-meta">Name</dt>
        <dd className="min-w-0 break-words text-fg-2" data-testid="shopify-confirm-label-value">{pending.accountLabel}</dd>
        <dt className="text-meta">Shopify permissions</dt>
        <dd className="min-w-0 break-words text-fg-2" data-testid="shopify-confirm-scopes">{scopes.length > 0 ? scopes.join(", ") : "Read only"}</dd>
        <dt className="text-meta">Access tokens</dt>
        <dd className="text-fg-2" data-testid="shopify-confirm-tokens">
          {tokens === 0 ? "None can read orders yet." : `${tokens} ${tokens === 1 ? "token" : "tokens"} can read this store's orders.`}
        </dd>
      </dl>
      <p className="mt-3 text-sm text-fg-2" data-testid="shopify-confirm-disclosure">{READ_SCOPE_DISCLOSURES["connections:read"]}</p>
      <p className="mt-2 text-sm text-fg-2" data-testid="shopify-confirm-retention">{CONNECTION_RETENTION_LINE}</p>
      {error ? <div className="mt-3"><ErrorNote error={error} /></div> : null}
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={() => cancel.mutate()} disabled={busy} aria-busy={cancel.isPending}>
          {cancel.isPending ? "Cancelling…" : "Cancel"}
        </Button>
        <Button onClick={() => confirm.mutate()} disabled={busy} aria-busy={confirm.isPending}>
          <Plug aria-hidden />{confirm.isPending ? "Connecting…" : "Connect store"}
        </Button>
      </div>
    </div>
  );
}

function ConnectForm({ hasStores, onAction }: { hasStores: boolean; onAction: () => void }) {
  const api = useApi();
  const { leaving, go } = useLeave();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  const connect = useMutation({
    mutationFn: (shopDomain: string) => api.startManagedConnect(TOOLKIT, shopDomain),
    onSuccess: ({ authorizeUrl }) => go(authorizeUrl),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const shopDomain = parseShopDomain(value);
    setInvalid(shopDomain === null);
    if (shopDomain === null) return;
    onAction();
    connect.mutate(shopDomain);
  };

  const connecting = connect.isPending || leaving;
  const error = invalid ? SHOP_DOMAIN_HELP : connect.isError ? connectErrorMessage(connect.error) : null;

  return (
    <form onSubmit={submit} noValidate className={cn("space-y-2", hasStores ? "mt-4" : "")} data-testid="shopify-connect-form">
      <Label htmlFor="shopify-domain">Store address</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="shopify-domain"
          name="shopDomain"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="your-store.myshopify.com"
          value={value}
          onChange={(event) => { setValue(event.target.value); setInvalid(false); }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "shopify-domain-error" : "shopify-domain-help"}
          disabled={connecting}
        />
        <Button type="submit" disabled={connecting || value.trim() === ""} aria-busy={connecting} aria-describedby={error ? "shopify-domain-error" : "shopify-domain-help"} className="sm:shrink-0">
          <Plug aria-hidden />{connecting ? "Opening Shopify…" : "Connect Shopify"}
        </Button>
      </div>
      {error ? <p id="shopify-domain-error" role="alert" className="text-sm text-danger" data-testid="shopify-connect-error">{error}</p>
        : <p id="shopify-domain-help" className="text-xs text-meta">{SHOP_DOMAIN_HELP}</p>}
    </form>
  );
}

/** Where a store comes from once the native tier is on (C-18): the App Store, never a typed address. */
function AppStoreNote() {
  return (
    <p className="mt-4 text-sm text-fg-2" data-testid="shopify-app-store-note">
      To connect a store, install ZS Business Connections from the Shopify App Store. Open it in your Shopify admin, then link the store to this hub there or with the link code above.
    </p>
  );
}

/** The claim read failed without saying whether the native tier is on: no address form is guessed (C-18). */
function NativeUnknownNote({ retry }: { retry: () => void }) {
  return (
    <p className="mt-4 text-sm text-fg-2" role="status" data-testid="shopify-native-unknown">
      We could not check how to connect a store right now.{" "}
      <button type="button" onClick={retry} className="inline-flex min-h-11 items-center font-bold text-accent-ink underline-offset-4 hover:underline">Try again</button>
    </p>
  );
}

function ShopRow({ connection, nativeState, onAction, onRelink }: { connection: ManagedConnection; nativeState: NativeShopify; onAction: () => void; onRelink: (active: boolean) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const { leaving, go } = useLeave();
  const intentKeys = useIntentKey();
  // Which dialog is open, for the connection it was opened for. It shows only while that connection is
  // still the live one, so a later state never opens with the dialog up.
  const [dialog, setDialog] = useState<"disconnect" | "reconnect" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const disconnected = useRef(false);

  const live = connection.status === "active" || connection.status === "reauthorize";
  const shown = STATE[connection.status];
  const name = connection.accountLabel ?? connection.accountDomain;
  const rowId = `shopify-${connection.id}`;
  const payload = { connectionId: connection.id };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.managedConnections });

  const disconnect = useMutation({
    mutationFn: () => api.disconnectManagedConnection(connection.id, { idempotencyKey: intentKeys.keyFor(payload) }),
    onSettled: async (_result, error) => {
      // A lost answer keeps the key, so a retry replays the first attempt instead of a second one.
      intentKeys.settle(payload, error);
      // Read the list again after every answer, a lost one too: it says what happened.
      await refresh();
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ManagedConnection[]>(keys.managedConnections, (items) => items?.map((item) => (item.id === result.id ? result : item)));
      disconnected.current = true;
      setDialog(null);
      toast(`Disconnecting ${name}. Agents can no longer read its orders.`, "info");
    },
  });

  // Reconnect is a disconnect, then a connect to the same store (C-13). The connect waits until the list says
  // the old link is disconnected: while it is disconnecting the API answers 409 already_connected (C-4).
  const reconnect = useMutation({
    mutationFn: () => reconnectStore(api, connection, intentKeys.keyFor(payload)),
    onError: (error) => {
      // The row has moved on to "Disconnecting" and closed the dialog, so the reason goes to a toast.
      if (error instanceof DisconnectPendingError) toast(error.message, "info");
    },
    onSettled: async (_result, error) => {
      intentKeys.settle(payload, error);
      await refresh();
    },
    onSuccess: ({ authorizeUrl }) => {
      setDialog(null);
      go(authorizeUrl);
    },
  });

  // C-18: a legacy Composio row under the native tier cannot be re-linked (the worker refuses it): Reconnect disconnects it and
  // starts the native install's link code instead.
  const path = reconnectPath(connection, nativeState);
  const nativeInstall = useMutation({
    mutationFn: async () => {
      // The claim card makes the code by itself once the old link is gone; set before the disconnect so a manual start cannot overlap it.
      onRelink(true);
      await disconnectForNativeInstall(api, connection, intentKeys.keyFor(payload));
    },
    onError: (error) => {
      onRelink(false);
      if (error instanceof DisconnectPendingError) toast(error.message, "info");
    },
    onSettled: async (_result, error) => {
      intentKeys.settle(payload, error);
      await refresh();
    },
    onSuccess: () => setDialog(null),
  });

  const busy = disconnect.isPending || reconnect.isPending || nativeInstall.isPending;

  return (
    <li aria-labelledby={`${rowId}-name`} data-testid="shopify-row" className="flex flex-wrap items-start gap-3 px-4 py-4 sm:flex-nowrap lg:px-6">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${rowId}-name`} ref={headingRef} tabIndex={-1} className="text-sm font-bold outline-none">{name}</h3>
          <Badge tone={shown.tone} data-testid="shopify-status"><shown.icon aria-hidden />{shown.label}</Badge>
        </div>
        <p className="text-sm break-words text-fg-2" data-testid="shopify-domain">{connection.accountDomain}</p>
        <p className="text-xs text-meta">Checked {relativeTime(connection.lastCheckedAt).toLowerCase()}</p>
        {connection.status === "reauthorize" ? <Warning>{reauthorizeMessage(connection.reauthorizeReason)}</Warning> : null}
        {connection.status === "active" && connection.readBlocked ? <Warning>{READ_BLOCKED_MESSAGE}</Warning> : null}
        {connection.status === "disconnecting" ? <p className="text-xs text-meta">Removing our access and asking Shopify to remove the app&apos;s access.</p> : null}
        {connection.revokeFailed ? <Warning>{REVOKE_FAILED_MESSAGE}</Warning> : null}
      </div>
      {live ? (
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap sm:justify-end">
          {connection.status === "reauthorize" && path === "none" ? null : connection.status === "reauthorize" && path === "reopen" ? (
            <p className="max-w-xs text-xs text-meta" data-testid="shopify-reopen-note">To reconnect, open ZS Business Connections in your Shopify admin.</p>
          ) : connection.status === "reauthorize" ? (
            <Button variant="primary" onClick={() => { reconnect.reset(); nativeInstall.reset(); setDialog("reconnect"); }} disabled={leaving} aria-busy={leaving}>
              <ArrowsClockwise aria-hidden />Reconnect<span className="sr-only"> {name}</span>
            </Button>
          ) : null}
          <Button variant="danger-outline" onClick={() => { disconnect.reset(); setDialog("disconnect"); }}>
            <Plugs aria-hidden />Disconnect<span className="sr-only"> {name}</span>
          </Button>
        </div>
      ) : null}
      <Dialog open={live && dialog === "disconnect"} onOpenChange={(open) => { if (!busy) setDialog(open ? "disconnect" : null); }}>
        {live && dialog === "disconnect" ? (
          <DialogContent
            title={DISCONNECT_TITLE}
            description={`${name} (${connection.accountDomain}) stops syncing with Zero Sum.`}
            onCloseAutoFocus={(event) => {
              if (!disconnected.current) return;
              disconnected.current = false;
              event.preventDefault();
              headingRef.current?.focus();
            }}
          >
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-fg-2" data-testid="shopify-disconnect-copy">
              <li>{DISCONNECT_WHAT}</li>
              <li>{DISCONNECT_AGENTS}</li>
              <li>If Shopify does not confirm, we tell you how to remove the app in your Shopify admin.</li>
            </ul>
            {disconnect.isError ? <div className="mb-4"><ErrorNote error={disconnect.error} /></div> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose asChild><Button variant="ghost" disabled={disconnect.isPending}>Keep connected</Button></DialogClose>
              <Button variant="danger" onClick={() => { onAction(); disconnect.mutate(); }} disabled={disconnect.isPending} aria-busy={disconnect.isPending}>
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={connection.status === "reauthorize" && dialog === "reconnect"} onOpenChange={(open) => { if (!busy) setDialog(open ? "reconnect" : null); }}>
        {connection.status === "reauthorize" && dialog === "reconnect" ? (
          <DialogContent title={RECONNECT_TITLE} description={`${name} (${connection.accountDomain})`}>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-fg-2" data-testid="shopify-reconnect-copy">
              {path === "native_install" ? (
                <>
                  <li>{RECONNECT_NATIVE_WHAT}</li>
                  <li>{DISCONNECT_WHAT}</li>
                  <li>{RECONNECT_NATIVE_NEXT}</li>
                  <li>{RECONNECT_NATIVE_CONFIRM}</li>
                </>
              ) : (
                <>
                  <li>{RECONNECT_WHAT}</li>
                  <li>{DISCONNECT_WHAT}</li>
                  <li>You confirm the store again when you come back.</li>
                </>
              )}
            </ul>
            {path === "native_install" && nativeInstall.isError ? <div className="mb-4"><p role="alert" className="text-sm text-danger" data-testid="shopify-reconnect-error">{connectErrorMessage(nativeInstall.error)}</p></div> : null}
            {path !== "native_install" && reconnect.isError ? <div className="mb-4"><p role="alert" className="text-sm text-danger" data-testid="shopify-reconnect-error">{connectErrorMessage(reconnect.error)}</p></div> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose asChild><Button variant="ghost" disabled={busy}>Not now</Button></DialogClose>
              <Button onClick={() => { onAction(); if (path === "native_install") nativeInstall.mutate(); else reconnect.mutate(); }} disabled={busy} aria-busy={busy}>
                <ArrowsClockwise aria-hidden />{busy ? "Reconnecting…" : "Reconnect"}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </li>
  );
}

function Warning({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-fg-2" data-testid="shopify-warning">
      <WarningCircle size={16} aria-hidden className="mt-px shrink-0 text-warn" />
      <span>{children}</span>
    </p>
  );
}
