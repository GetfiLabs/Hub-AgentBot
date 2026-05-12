"use client";

// Legacy redirect. Agent management UI moved into the Profile page.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AgentManageRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/profile");
  }, [router]);

  return (
    <div className="app-shell grid min-h-[40vh] place-items-center py-12 text-center">
      <p className="text-sm text-[var(--muted)]">Redirecting to your Profile…</p>
    </div>
  );
}
