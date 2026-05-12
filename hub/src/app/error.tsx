"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function Error({
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
        <h1 className="mt-5 text-2xl font-black text-heading">Something went wrong</h1>
        <p className="mt-2 text-[var(--muted)]">An unexpected error occurred. Please try again.</p>
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-[var(--muted)]">Error code: {error.digest}</p>
        )}
        <button onClick={unstable_retry} className="command-button mt-6 px-5">
          <RotateCcw className="h-4 w-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
