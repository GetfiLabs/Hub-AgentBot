import type { Metadata } from "next";
import { Lilita_One, Nunito, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { Analytics } from "@vercel/analytics/react";
import { AppProvider } from "@/context/AppContext";
import Navbar from "@/components/Navbar";
import { WalletContextProvider } from "@/components/WalletContextProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["400", "500", "700", "800", "900"],
  display: "swap",
});

const lilita = Lilita_One({
  variable: "--font-lilita",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GetFi Hub",
    template: "%s | GetFi Hub",
  },
  description:
    "The official portal for the GetFi ecosystem. Turn the G you collect across GetFi games into on-chain $GET on Solana.",
  keywords: ["GetFi", "Web3", "Solana", "Gaming", "Play to Earn", "Lootbox", "dApp"],
  openGraph: {
    title: "GetFi Hub",
    description:
      "Turn game progress into verifiable on-chain rewards. Connect your games, earn G tokens, and open Solana lootboxes.",
    siteName: "GetFi Hub",
    type: "website",
    locale: "tr_TR",
  },
  twitter: {
    card: "summary_large_image",
    title: "GetFi Hub",
    description: "Turn game progress into verifiable on-chain rewards on Solana.",
  },
  robots: { index: true, follow: true },
  manifest: "/manifest.json",
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "apple-mobile-web-app-title": "GetFi Hub",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#082159" />
      </head>
      <body className={`${nunito.variable} ${lilita.variable} ${jetbrains.variable} antialiased`}>
        <div className="grain" aria-hidden="true"></div>
        <WalletContextProvider>
          <ThemeProvider>
            <AppProvider>
              <div className="app-wrapper">
                <Navbar />
                <a
                  href="#main-content"
                  className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-20 focus:z-[60] focus:rounded-lg focus:bg-[var(--gold)] focus:px-4 focus:py-2 focus:font-bold focus:text-[#162447]"
                >
                  Skip to content
                </a>
                <main id="main-content" className="pb-24 pt-[var(--hdr-h,76px)] md:pb-10">
                  {children}
                </main>
              </div>
              <Toaster
                position="bottom-right"
                toastOptions={{
                  className: "font-sans text-sm font-bold",
                  style: {
                    background: "var(--surface)",
                    color: "var(--ink)",
                    border: "1px solid var(--navy-outline)",
                  },
                }}
              />
              <Analytics />
              <script
                dangerouslySetInnerHTML={{
                  __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})};window.addEventListener('load',function(){setInterval(function(){var m=document.querySelectorAll('.wallet-adapter-modal-list,.wallet-adapter-modal-list-more');m.forEach(function(e){e.style.maxHeight='none';e.style.overflow='visible';e.style.height='auto'});var c=document.querySelector('.wallet-adapter-collapse');if(c){c.style.display='none';c.style.maxHeight='0';c.style.overflow='hidden'}},100)})`,
                }}
              />
            </AppProvider>
          </ThemeProvider>
        </WalletContextProvider>
      </body>
    </html>
  );
}
