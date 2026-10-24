"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CURRENCIES, currencyLabel, type BusinessProfile, type UpdateBusinessProfileRequest } from "@zs/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { isApiError, isSettingsChanged } from "@/lib/api";
import { useApi, useApiRuntime } from "@/lib/api/react";
import { timeZoneChoices, zoneName } from "@/lib/agents";
import {
  countryChoices,
  fieldFromIssuePath,
  readBusinessForm,
  serverFieldMessage,
  toBusinessForm,
  type BusinessField,
  type BusinessForm,
  type BusinessFormErrors,
} from "@/lib/business-profile";
import { useIntentKey } from "@/lib/intent-key";
import { useBusinessProfile, useKeys } from "@/lib/queries";
import { MANAGE_BUSINESS, useCan, useIdentity, useSession } from "@/lib/session";
import { singleFlight } from "@/lib/single-flight";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match device" },
] as const satisfies readonly { value: Theme; label: string }[];

// Nothing sends these yet, so they stay off and say so.
const NOTIFY = [
  { id: "booking", label: "New booking", hint: "When someone books." },
  { id: "approval", label: "Agent needs approval", hint: "When a draft is waiting." },
  { id: "digest", label: "Monday results", hint: "Last week's numbers." },
];

export const STALE_BUSINESS_MESSAGE = "Someone else saved the business details while you were editing. The latest details are loaded below. Check them and save again.";
export const BUSINESS_OWNER_ONLY = "Only an owner can change business details.";
/** BP-10: an API that is older than the profile has no `GET /v1/business`. */
export const BUSINESS_NOT_AVAILABLE = "Profile not available yet. This form turns on when the server is updated.";
export const BUSINESS_UNCHANGED = "Nothing to save yet. Change a detail first.";
export const BUSINESS_SAVED = "Business details saved.";
/** BP-11: the demo keeps the profile in memory, so a save must not look stored. */
export const BUSINESS_DEMO_SAVED = "Saved in this demo only. It is sample data and resets when you reload the page.";
export const BUSINESS_DEMO_NOTE = "This is sample data. Saving works here, but nothing is stored: it resets when you reload the page.";

const FIELD_IDS: Record<BusinessField, string> = {
  displayName: "biz-name",
  legalName: "biz-legal",
  phone: "biz-phone",
  timeZone: "biz-zone",
  currency: "biz-currency",
  line1: "biz-line1",
  line2: "biz-line2",
  city: "biz-city",
  region: "biz-region",
  postalCode: "biz-postal",
  country: "biz-country",
};

const sameForm = (a: BusinessForm, b: BusinessForm) => (Object.keys(a) as BusinessField[]).every((field) => a[field] === b[field]);

/** Reads the API's validation issues as form fields; a path it does not know shows under the name. */
function serverErrors(error: unknown): BusinessFormErrors | null {
  if (!isApiError(error, "validation")) return null;
  const issues = Array.isArray(error.details.issues) ? error.details.issues : [];
  const errors: BusinessFormErrors = {};
  for (const issue of issues) {
    const path = (issue as { path?: unknown } | null)?.path;
    const field = typeof path === "string" ? fieldFromIssuePath(path) : null;
    if (field) errors[field] = serverFieldMessage(field);
  }
  return errors;
}

export function SettingsView() {
  const theme = useTheme();
  return (
    <>
      <PageHeader title="Settings" description="Business details and how we reach you." />
      <div className="tray grid max-w-3xl gap-1.5 lg:gap-2">
        <Card aria-labelledby="appearance-title">
          <CardHeader>
            <div>
              <CardTitle id="appearance-title">Appearance</CardTitle>
              <p className="text-sm text-muted">Saved on this device. Match device follows your phone or computer.</p>
            </div>
          </CardHeader>
          <Segmented label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
        </Card>
        <BusinessCard />
        <Card aria-labelledby="notify-title">
          <CardHeader>
            <div>
              <CardTitle id="notify-title">Notifications</CardTitle>
              <p id="notify-unavailable" className="text-sm text-muted">Coming soon. Nothing sends these yet.</p>
            </div>
          </CardHeader>
          <ul className="divide-y divide-border-soft">
            {NOTIFY.map((item) => (
              <li key={item.id} className="flex items-center gap-4 py-2">
                <div className="flex-1">
                  <p id={`n-${item.id}`} className="text-sm font-medium text-fg">{item.label}</p>
                  <p className="text-sm text-muted">{item.hint}</p>
                </div>
                <Switch aria-labelledby={`n-${item.id}`} disabled aria-describedby="notify-unavailable" checked={false} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

/** Who the business is (business-profile.md): any member reads it, an owner changes it. */
function BusinessCard() {
  const profile = useBusinessProfile();
  const identity = useIdentity();
  const owner = useCan(MANAGE_BUSINESS);

  let body: ReactNode;
  if (profile.isPending) {
    body = <LoadingRows rows={3} label="Loading business details" />;
  } else if (profile.isError && isApiError(profile.error, "not_found")) {
    // BP-10: the server is older than the profile. Show what is known, and why it cannot change.
    const known: BusinessProfile = {
      displayName: identity?.businessName ?? "", legalName: null, phoneE164: null, timeZone: null, currency: "USD",
      postalAddress: null, revision: 1, updatedAt: "",
    };
    body = <BusinessFormBody profile={known} reload={async () => undefined} lockedReason={BUSINESS_NOT_AVAILABLE} />;
  } else if (profile.isError) {
    body = <ErrorNote error={profile.error} retry={() => void profile.refetch()} />;
  } else {
    body = (
      <BusinessFormBody
        profile={profile.data}
        reload={async () => { await profile.refetch(); }}
        lockedReason={owner ? null : BUSINESS_OWNER_ONLY}
      />
    );
  }
  return (
    <Card aria-labelledby="business-title">
      <CardHeader><CardTitle id="business-title">Business</CardTitle></CardHeader>
      {body}
    </Card>
  );
}

function BusinessFormBody({ profile, reload, lockedReason }: {
  profile: BusinessProfile;
  reload: () => Promise<void>;
  /** Why the form cannot be changed, or null when the person may save. */
  lockedReason: string | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const { setBusinessName } = useSession();
  const demo = useApiRuntime().mode === "demo";
  const [draft, setDraft] = useState<{ revision: number; form: BusinessForm } | null>(null);
  const [errors, setErrors] = useState<BusinessFormErrors>({});
  const [stale, setStale] = useState(false);
  const [saveOnce] = useState(singleFlight);

  const saved = useMemo(() => toBusinessForm(profile), [profile]);
  const form = draft?.form ?? saved;
  const revision = draft?.revision ?? profile.revision;
  const dirty = !sameForm(form, saved);
  const zones = useMemo(() => timeZoneChoices(form.timeZone), [form.timeZone]);
  const countries = useMemo(() => countryChoices(), []);
  const locked = lockedReason !== null;
  const unchanged = !locked && !dirty;

  const edit = (patch: Partial<BusinessForm>) => setDraft({ revision, form: { ...form, ...patch } });

  const save = useMutation({
    mutationFn: (input: UpdateBusinessProfileRequest) => api.updateBusiness(input, { idempotencyKey: intents.keyFor(input) }),
    onSettled: (_profile, error, input) => intents.settle(input, error),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.business, next);
      setBusinessName(next.displayName);
      setDraft(null);
      setErrors({});
      toast(demo ? BUSINESS_DEMO_SAVED : BUSINESS_SAVED);
    },
    onError: async (error) => {
      if (isSettingsChanged(error)) {
        setStale(true);
        await reload();
        setDraft(null);
        return;
      }
      const fields = serverErrors(error);
      if (fields) setErrors(fields);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    const read = readBusinessForm(profile, form);
    if (!read.ok) {
      setErrors(read.errors);
      const first = (Object.keys(FIELD_IDS) as BusinessField[]).find((field) => read.errors[field]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setErrors({});
    setStale(false);
    if (Object.keys(read.changes).length === 0) return;
    saveOnce(() => save.mutateAsync({ expectedRevision: revision, changes: read.changes }));
  };

  const errorId = (field: BusinessField) => `${FIELD_IDS[field]}-error`;
  const props = (field: BusinessField, hint = false) => ({
    id: FIELD_IDS[field],
    "aria-invalid": errors[field] ? (true as const) : undefined,
    "aria-describedby": [errors[field] ? errorId(field) : null, hint ? `${FIELD_IDS[field]}-hint` : null].filter(Boolean).join(" ") || undefined,
  });
  const note = (field: BusinessField, hint?: string) => (
    <>
      {errors[field] ? <p id={errorId(field)} className="mt-1 text-xs text-danger">{errors[field]}</p> : null}
      {hint ? <p id={`${FIELD_IDS[field]}-hint`} className="mt-1 text-xs text-meta">{hint}</p> : null}
    </>
  );
  const text = (field: BusinessField, label: string, extra: { hint?: string; type?: string; autoComplete?: string } = {}) => (
    <div>
      <Label htmlFor={FIELD_IDS[field]}>{label}</Label>
      <Input
        {...props(field, Boolean(extra.hint))}
        type={extra.type ?? "text"}
        autoComplete={extra.autoComplete}
        value={form[field]}
        onChange={(event) => edit({ [field]: event.target.value })}
      />
      {note(field, extra.hint)}
    </div>
  );

  return (
    <form className="space-y-4" onSubmit={submit} noValidate aria-labelledby="business-title">
      {stale ? <p role="alert" data-testid="business-stale" className="rounded-md bg-warn-tint p-3 text-sm text-fg-2">{STALE_BUSINESS_MESSAGE}</p> : null}
      <fieldset disabled={locked} className="space-y-4">
        {text("displayName", "Business name", { hint: "Shown in the header and the account menu." })}
        {text("legalName", "Legal name", { hint: "The registered name, if it differs. Leave empty if not." })}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {text("phone", "Business phone", { type: "tel", autoComplete: "tel", hint: "With country code, like +1 212 555 0142." })}
          <div>
            <Label htmlFor={FIELD_IDS.timeZone}>Time zone</Label>
            <Select {...props("timeZone")} className="w-full" value={form.timeZone} onChange={(event) => edit({ timeZone: event.target.value })}>
              <option value="">Not set</option>
              {zones.map((zone) => <option key={zone} value={zone}>{zoneName(zone)}</option>)}
            </Select>
            {note("timeZone")}
          </div>
        </div>
        <div>
          <Label htmlFor={FIELD_IDS.currency}>Currency</Label>
          <Select {...props("currency", true)} className="w-full" value={form.currency} onChange={(event) => edit({ currency: event.target.value })}>
            {CURRENCIES.map((currency) => <option key={currency.code} value={currency.code}>{currencyLabel(currency.code)}</option>)}
          </Select>
          {note("currency", "New deals start in this currency. Saved amounts do not change.")}
        </div>
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-fg-2">Address</legend>
          {text("line1", "Street address", { autoComplete: "address-line1" })}
          {text("line2", "Apartment, suite or unit", { autoComplete: "address-line2" })}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {text("city", "City", { autoComplete: "address-level2" })}
            {text("region", "State or region", { autoComplete: "address-level1" })}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {text("postalCode", "Postal code", { autoComplete: "postal-code" })}
            <div>
              <Label htmlFor={FIELD_IDS.country}>Country</Label>
              <Select {...props("country")} className="w-full" value={form.country} onChange={(event) => edit({ country: event.target.value })}>
                <option value="">Not set</option>
                {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
              </Select>
              {note("country")}
            </div>
          </div>
        </fieldset>
      </fieldset>
      {Object.keys(errors).length > 0 ? <p role="alert" className="text-sm text-danger">Some details need another look.</p> : null}
      {save.isError && !isSettingsChanged(save.error) && !serverErrors(save.error) ? <ErrorNote error={save.error} /> : null}
      <div className="space-y-2">
        <Button type="submit" disabled={locked || !dirty || save.isPending} aria-busy={save.isPending} aria-describedby={locked ? "business-locked" : unchanged ? "business-unchanged" : undefined}>
          Save changes
        </Button>
        {locked ? <DisabledReason id="business-locked">{lockedReason}</DisabledReason> : null}
        {unchanged ? <DisabledReason id="business-unchanged">{BUSINESS_UNCHANGED}</DisabledReason> : null}
        {demo && !locked ? <DisabledReason id="business-demo-note">{BUSINESS_DEMO_NOTE}</DisabledReason> : null}
      </div>
    </form>
  );
}
