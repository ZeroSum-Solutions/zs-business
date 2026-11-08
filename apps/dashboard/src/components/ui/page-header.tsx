import type { ReactNode } from "react";
import { SampleBadge } from "./sample";

export function PageHeader({ title, description, actions, sample = false }: { title: string; description?: ReactNode; actions?: ReactNode; sample?: boolean }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 sm:items-center lg:mb-8">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl leading-tight font-extrabold tracking-display lg:text-3xl">{title}</h1>
          {sample ? <SampleBadge /> : null}
        </div>
        {description ? <p className="mt-2 text-body text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
