"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason, NOT_AVAILABLE, useSampleOnly } from "@/components/ui/sample";
import { PageHeader } from "@/components/ui/states";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { OWNER } from "@/components/shell/account-menu";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match device" },
] as const satisfies readonly { value: Theme; label: string }[];

const NOTIFY = [
  { id: "booking", label: "New booking", hint: "A text when someone books." },
  { id: "approval", label: "Agent needs approval", hint: "A push when a draft is waiting." },
  { id: "digest", label: "Monday results", hint: "An email with last week's numbers." },
];

export function SettingsView() {
  const toast = useToast();
  const sampleOnly = useSampleOnly();
  const [notify, setNotify] = useState<Record<string, boolean>>({ booking: true, approval: true, digest: false });
  const theme = useTheme();
  return (
    <>
      <PageHeader title="Settings" description="Business details and how we reach you." sample />
      <div className="grid max-w-3xl gap-4">
        <Card aria-labelledby="appearance-title">
          <CardHeader>
            <div>
              <CardTitle id="appearance-title">Appearance</CardTitle>
              <p className="text-sm text-muted">Saved on this device. Match device follows your phone or computer.</p>
            </div>
          </CardHeader>
          <Segmented label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} />
        </Card>
        <Card aria-labelledby="business-title">
          <CardHeader><CardTitle id="business-title">Business</CardTitle></CardHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!sampleOnly) toast("Settings saved."); }}>
            <div>
              <Label htmlFor="biz-name">Business name</Label>
              <Input id="biz-name" defaultValue={OWNER.legalName} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="biz-phone">Business phone</Label>
                <Input id="biz-phone" type="tel" defaultValue="+1 212 555 0100" />
              </div>
              <div>
                <Label htmlFor="biz-zone">Time zone</Label>
                <Select id="biz-zone" defaultValue="America/New_York" className="w-full">
                  <option value="America/New_York">Eastern (New York)</option>
                  <option value="America/Chicago">Central (Chicago)</option>
                  <option value="America/Denver">Mountain (Denver)</option>
                  <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Button type="submit" disabled={sampleOnly} aria-describedby={sampleOnly ? "settings-unavailable" : undefined}>Save changes</Button>
              {sampleOnly ? <DisabledReason id="settings-unavailable">{NOT_AVAILABLE}</DisabledReason> : null}
            </div>
          </form>
        </Card>
        <Card aria-labelledby="notify-title">
          <CardHeader><CardTitle id="notify-title">Notifications</CardTitle></CardHeader>
          {sampleOnly ? <DisabledReason id="notify-unavailable">{NOT_AVAILABLE}</DisabledReason> : null}
          <ul className="divide-y divide-border-soft">
            {NOTIFY.map((item) => (
              <li key={item.id} className="flex items-center gap-4 py-2">
                <div className="flex-1">
                  <p id={`n-${item.id}`} className="text-sm font-medium text-fg">{item.label}</p>
                  <p className="text-sm text-muted">{item.hint}</p>
                </div>
                <Switch aria-labelledby={`n-${item.id}`} disabled={sampleOnly} aria-describedby={sampleOnly ? "notify-unavailable" : undefined} checked={notify[item.id] ?? false} onCheckedChange={(checked) => setNotify({ ...notify, [item.id]: checked })} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
