import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-16">
      <h1 className="text-xl tracking-display">We could not find that page</h1>
      <p className="mt-2 text-sm text-muted">It may have moved.</p>
      <Link href="/" className="mt-4 inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline">Go to Home</Link>
    </div>
  );
}
