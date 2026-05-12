"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The dashboard route was the legacy home. Under the new design the canonical
// home page lives at `/`, so this is just a redirect to keep old links alive.
export default function DashboardPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return null;
}
