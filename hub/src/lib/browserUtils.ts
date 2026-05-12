export function isEmbeddedBrowser(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";

  // Phantom / Solflare inject window properties — most reliable signal
  const win = window as unknown as Record<string, unknown>;
  if (win.phantom || win.solflare) return true;

  // UA-based wallet browser detection (desktop and mobile)
  if (/Phantom|Solflare|Backpack|Glow|SolanaMobile/i.test(ua)) return true;

  // Standard Android WebView token
  if (/; wv\)/i.test(ua) || /WebView/i.test(ua)) return true;

  // Social-media in-app browsers (mobile only)
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  if (isMobile && /FBAN|FBAV|Instagram|Line\/|Twitter|TikTok/i.test(ua)) return true;

  return false;
}
