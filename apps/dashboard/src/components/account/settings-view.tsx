"use client";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason, NOT_AVAILABLE, useSampleOnly } from "@/components/ui/sample";
import { PageHeader } from "@/components/ui/states";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { useIdentity } from "@/lib/session";
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

/** Demo mode keeps no business details, so its form says so instead of looking saved. */
export const DEMO_SAVE_NOTE = "The demo does not save business details.";

export function SettingsView() {
  const sampleOnly = useSampleOnly();
  const identity = useIdentity();
  const theme = useTheme();
  return (
    <>
      <PageHeader title="Settings" description="Business details and how we reach you." sample />
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
        <Card aria-labelledby="business-title">
          <CardHeader><CardTitle id="business-title">Business</CardTitle></CardHeader>
          {/* No settings route exists yet (and no business time zone in the data model), so nothing here saves. */}
          <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
            <div>
              <Label htmlFor="biz-name">Business name</Label>
              <Input id="biz-name" key={identity?.businessName ?? ""} defaultValue={identity?.businessName ?? ""} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="biz-phone">Business phone</Label>
                <Input id="biz-phone" type="tel" />
              </div>
              <div>
                <Label htmlFor="biz-zone">Time zone</Label>
                <Select id="biz-zone" defaultValue="" className="w-full">
                  <option value="">Not set</option>
                  <option value="America/New_York">Eastern (New York)</option>
                  <option value="America/Chicago">Central (Chicago)</option>
                  <option value="America/Denver">Mountain (Denver)</option>
                  <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Button type="submit" disabled aria-describedby="settings-unavailable">Save changes</Button>
              <DisabledReason id="settings-unavailable">{sampleOnly ? NOT_AVAILABLE : DEMO_SAVE_NOTE}</DisabledReason>
            </div>
          </form>
        </Card>
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
