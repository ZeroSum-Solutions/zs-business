import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarView } from "@/components/calendar/calendar-view";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
  return (
    <Suspense>
      <CalendarView />
    </Suspense>
  );
}
