"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import Link from "next/link";

export default function AgentError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="app-shell grid min-h-[62vh] place-items-center py-12 text-center">
      <div className="panel max-w-md p-8">
        <AlertTriangle className="mx-auto h-12 w-12 text-[var(--error)]" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-black text-heading">Could not load agent page</h1>
        <p className="mt-2 text-[var(--muted)]">
          Something went wrong fetching on-chain state. Please try again.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-[var(--muted)]">Error code: {error.digest}</p>
        )}
        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <button onClick={unstable_retry} className="command-button px-5">
            <RotateCcw className="h-4 w-4" />
            Try again
          </button>
          <Link href="/" className="quiet-button px-5">
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
