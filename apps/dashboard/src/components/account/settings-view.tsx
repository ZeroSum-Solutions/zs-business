"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ACTIVE_CURRENCIES, BUSINESS_POLICIES_MAX, WEEKDAYS, currencyLabel, type BusinessProfile, type UpdateBusinessProfileRequest, type Weekday } from "@zs/contracts";
import type { BusinessProfileView } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { isApiError, isSettingsChanged } from "@/lib/api";
import { useApi, useApiRuntime } from "@/lib/api/react";
import { timeZoneChoices, zoneName } from "@/lib/agents";
import {
  WEEKDAY_NAMES,
  countryChoices,
  draftForm,
  factProvenance,
  fieldFromIssuePath,
  newerProfile,
  normalizedForm,
  readBusinessForm,
  serverFieldMessage,
  toBusinessForm,
  type BusinessField,
  type BusinessForm,
  type BusinessFormErrors,
  type BusinessTextField,
  type DayHours,
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

export const STALE_BUSINESS_MESSAGE = "Someone else saved the business details while you were editing. The latest details are loaded below. Check them and save again.";
export const BUSINESS_OWNER_ONLY = "Only an owner can change business details.";
/** BP-10: an API that is older than the profile has no `GET /v1/business`. */
export const BUSINESS_NOT_AVAILABLE = "Profile not available yet. This form turns on when the server is updated.";
export const BUSINESS_UNCHANGED = "Nothing to save yet. Change a detail first.";
export const BUSINESS_SAVED = "Business details saved.";
/** BP-11: the demo keeps the profile in memory, so a save must not look stored. */
export const BUSINESS_DEMO_SAVED = "Saved in this demo only. It is sample data and resets when you reload the page.";
/** BP-21: a fact nobody set is "not known" to the agents, never guessed. */
export const FACT_NOT_SET = "Not set. Agents say this is not known and do not guess.";
export const FACT_SET_UNRECORDED = "Set before who set it was recorded.";
/** The API sent no company facts, or a shape this screen does not know: they cannot be changed here yet. */
export const FACTS_UNAVAILABLE = "Can't be shown or changed until the server is updated. Agents treat it as not known.";
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
  description: "biz-description",
  services: "biz-services",
  hours: "biz-hours",
  tone: "biz-tone",
  policies: "biz-policies",
};

// A closed day's old times and an empty policy row are not changes (normalizedForm).
const sameForm = (a: BusinessForm, b: BusinessForm) => {
  const [left, right] = [normalizedForm(a), normalizedForm(b)];
  return (Object.keys(left) as BusinessField[]).every((field) => JSON.stringify(left[field]) === JSON.stringify(right[field]));
};

const setAtLabel = (setAt: string) => {
  const date = new Date(setAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** BP-19, BP-21: who set a company fact and when, or that agents treat it as not known. */
function provenanceLine(profile: BusinessProfileView, fact: "hours" | "tone" | "policies"): string {
  if (profile.factsUnavailable) return FACTS_UNAVAILABLE;
  const read = factProvenance(profile, fact);
  if (!read.known) return FACT_NOT_SET;
  if (!read.mark) return FACT_SET_UNRECORDED;
  const date = setAtLabel(read.mark.setAt);
  return date ? `Set by an owner on ${date}.` : "Set by an owner.";
}

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
  // Issues that name no field of this form (an older API refusing a new field) show as the general error.
  return Object.keys(errors).length > 0 ? errors : null;
}

export function SettingsView() {
  const theme = useTheme();
  return (
    <>
      <PageHeader title="Settings" description="Business details and how the hub looks." />
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
        {/* No notification settings: nothing sends them, so the card is left out until an API does. */}
        <BusinessCard />
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
    // The currency is not known (empty), so the form says "Not available" rather than inventing one.
    const known: BusinessProfile = {
      displayName: identity?.businessName ?? "", legalName: null, phoneE164: null, timeZone: null, currency: "",
      postalAddress: null, description: null, services: [], hours: null, tone: null, policies: [], factMarks: {},
      revision: 1, updatedAt: "",
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
  profile: BusinessProfileView;
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
  const [draft, setDraft] = useState<{ revision: number; form: BusinessForm; factsLocked: boolean } | null>(null);
  const [errors, setErrors] = useState<BusinessFormErrors>({});
  const [stale, setStale] = useState(false);
  const [saveOnce] = useState(singleFlight);

  const saved = useMemo(() => toBusinessForm(profile), [profile]);
  // BP-16..BP-19: facts this screen could not read stay read-only and are never sent.
  const factsLocked = profile.factsUnavailable === true;
  const form = draftForm(draft, saved, factsLocked);
  const revision = draft?.revision ?? profile.revision;
  const dirty = !sameForm(form, saved);
  const zones = useMemo(() => timeZoneChoices(form.timeZone).filter((zone) => zone !== ""), [form.timeZone]);
  const countries = useMemo(() => countryChoices(), []);
  const locked = lockedReason !== null;
  const unchanged = !locked && !dirty;

  const edit = (patch: Partial<BusinessForm>) => setDraft({ revision, form: { ...form, ...patch }, factsLocked });

  const save = useMutation({
    mutationFn: (input: UpdateBusinessProfileRequest) => api.updateBusiness(input, { idempotencyKey: intents.keyFor(input) }),
    // A read that started before the save must not land after it and put the old values back.
    onMutate: () => queryClient.cancelQueries({ queryKey: keys.business }),
    onSettled: (_profile, error, input) => intents.settle(input, error),
    onSuccess: (next) => {
      // A replayed answer can be older than what is cached: never move the cache back a revision.
      const latest = newerProfile(queryClient.getQueryData<BusinessProfileView>(keys.business), next);
      queryClient.setQueryData(keys.business, latest);
      setBusinessName(latest.displayName);
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
  const provenance = (fact: "hours" | "tone" | "policies") => (
    <p data-testid={`provenance-${fact}`} className="mt-1 text-xs text-meta">{provenanceLine(profile, fact)}</p>
  );
  // BP-18: a saved policy shows its own mark; a new or edited one has none until it is saved.
  const savedPolicyLine = (draft: { title: string; text: string }) => {
    const saved = factsLocked ? undefined : profile.policies.find((policy) => policy.title === draft.title.trim() && policy.text === draft.text.trim());
    const date = saved ? setAtLabel(saved.setAt) : null;
    if (!saved) return null;
    return <p className="text-xs text-meta">{date ? `Set by an owner on ${date}.` : "Set by an owner."}</p>;
  };
  const editDay = (day: Weekday, patch: Partial<DayHours>) => edit({ hours: { ...form.hours, [day]: { ...form.hours[day], ...patch } } });
  const editPolicy = (index: number, patch: Partial<BusinessForm["policies"][number]>) =>
    edit({ policies: form.policies.map((policy, at) => (at === index ? { ...policy, ...patch } : policy)) });
  const text = (field: BusinessTextField, label: string, extra: { hint?: string; type?: string; autoComplete?: string } = {}) => (
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
      {/* Held while a save is in flight, so an edit made meanwhile is not wiped when the answer clears the draft. */}
      <fieldset disabled={locked || save.isPending} className="space-y-4">
        {text("displayName", "Business name", { hint: "Shown in the header and the account menu." })}
        {text("legalName", "Legal name", { hint: "The registered name, if it differs. Leave empty if not." })}
        <div>
          <Label htmlFor={FIELD_IDS.description}>Description</Label>
          <Textarea {...props("description", true)} rows={4} value={form.description} onChange={(event) => edit({ description: event.target.value })} />
          {note("description", "What the business does, in a few sentences. Leave empty if not.")}
        </div>
        <div>
          <Label htmlFor={FIELD_IDS.services}>Services</Label>
          <Textarea {...props("services", true)} rows={4} value={form.services} onChange={(event) => edit({ services: event.target.value })} />
          {note("services", "One service per line, like Bridal consultation.")}
        </div>
        <fieldset id={FIELD_IDS.hours} tabIndex={-1} disabled={factsLocked} className="space-y-2" aria-describedby={[errors.hours ? errorId("hours") : null, `${FIELD_IDS.hours}-hint`].filter(Boolean).join(" ")}>
          <legend className="mb-1.5 text-sm font-semibold text-fg-2">Opening hours</legend>
          {WEEKDAYS.map((day) => {
            const entry = form.hours[day];
            const name = WEEKDAY_NAMES[day];
            return (
              <div key={day} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2" data-testid={`hours-${day}`}>
                <div className="flex w-36 items-center gap-1">
                  <Switch
                    id={`biz-hours-${day}`}
                    aria-label={`Open on ${name}`}
                    checked={entry.isOpen}
                    onCheckedChange={(isOpen) => editDay(day, isOpen ? { isOpen } : { isOpen, open: "", close: "" })}
                  />
                  <label htmlFor={`biz-hours-${day}`} className="text-sm text-fg">{name}</label>
                </div>
                {entry.isOpen ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Input type="time" aria-label={`${name} opens`} aria-invalid={errors.hours ? true : undefined} className="min-w-0 flex-1" value={entry.open} onChange={(event) => editDay(day, { open: event.target.value })} />
                    <span className="text-sm text-meta" aria-hidden>to</span>
                    <Input type="time" aria-label={`${name} closes`} aria-invalid={errors.hours ? true : undefined} className="min-w-0 flex-1" value={entry.close} onChange={(event) => editDay(day, { close: event.target.value })} />
                  </div>
                ) : <span className="text-sm text-meta">Closed</span>}
              </div>
            );
          })}
          {note("hours", "Turn on the days you open and give each one its times. Days left off are saved as closed. To close at midnight, set the closing time to 00:00 (12:00 AM). With every day off, the hours are not set.")}
          {provenance("hours")}
        </fieldset>
        <div>
          <Label htmlFor={FIELD_IDS.tone}>Tone of voice</Label>
          <Textarea {...props("tone", true)} rows={3} disabled={factsLocked} value={form.tone} onChange={(event) => edit({ tone: event.target.value })} />
          {note("tone", "How agents should sound when they write for you, like Warm and plain, no exclamation marks. Agents read this, so leave customer details out.")}
          {provenance("tone")}
        </div>
        <fieldset id={FIELD_IDS.policies} tabIndex={-1} disabled={factsLocked} className="space-y-3" aria-describedby={[errors.policies ? errorId("policies") : null, `${FIELD_IDS.policies}-hint`].filter(Boolean).join(" ")}>
          <legend className="mb-1.5 text-sm font-semibold text-fg-2">Policies</legend>
          {form.policies.map((policy, index) => (
            <div key={index} className="space-y-2 rounded-md bg-inset p-3" data-testid="policy-row">
              <div>
                <Label htmlFor={`biz-policy-title-${index}`}>Title</Label>
                <Input id={`biz-policy-title-${index}`} aria-invalid={errors.policies ? true : undefined} value={policy.title} placeholder="Cancellation" onChange={(event) => editPolicy(index, { title: event.target.value })} />
              </div>
              <div>
                <Label htmlFor={`biz-policy-text-${index}`}>Policy</Label>
                <Textarea id={`biz-policy-text-${index}`} aria-invalid={errors.policies ? true : undefined} rows={3} value={policy.text} onChange={(event) => editPolicy(index, { text: event.target.value })} />
              </div>
              {savedPolicyLine(policy)}
              <Button
                variant="ghost"
                aria-label={`Remove ${policy.title.trim() === "" ? "this policy" : policy.title.trim()}`}
                onClick={() => edit({ policies: form.policies.filter((_, at) => at !== index) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button variant="secondary" disabled={form.policies.length >= BUSINESS_POLICIES_MAX} onClick={() => edit({ policies: [...form.policies, { title: "", text: "" }] })}>
            Add a policy
          </Button>
          {note("policies", `Rules customers ask about, like cancellation, refunds or deposits. Up to ${BUSINESS_POLICIES_MAX}. Agents read these, so leave customer details out.`)}
          {provenance("policies")}
        </fieldset>
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
            {form.currency === "" ? <option value="">Not available</option> : null}
            {ACTIVE_CURRENCIES.map((currency) => <option key={currency.code} value={currency.code}>{currencyLabel(currency.code)}</option>)}
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
