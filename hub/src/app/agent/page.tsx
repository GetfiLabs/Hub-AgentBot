"use client";

// Legacy redirect. Agent UI moved into the Profile page.
// We preserve the `?agent=...` query param the Telegram bot uses.

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function AgentRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const agent = params.get("agent");
    const target = agent ? `/profile?agent=${encodeURIComponent(agent)}` : "/profile";
    router.replace(target);
  }, [params, router]);

  return (
    <div className="app-shell grid min-h-[40vh] place-items-center py-12 text-center">
      <p className="text-sm text-[var(--muted)]">Redirecting to your Profile…</p>
    </div>
  );
}
