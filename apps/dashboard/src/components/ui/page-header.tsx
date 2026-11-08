import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 sm:items-center lg:mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl leading-tight font-extrabold tracking-display lg:text-3xl">{title}</h1>
        {description ? <p className="mt-2 text-body text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
