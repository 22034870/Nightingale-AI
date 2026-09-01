import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nightingale",
  description: "Ask a clinic a question. No account needed to start.",
  applicationName: "Nightingale",
  appleWebApp: { capable: true, title: "Nightingale", statusBarStyle: "default" },
  // This is a health surface. It should never appear in a search result, and
  // no referrer should leak which clinic or topic a person was reading.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5, // never block pinch-zoom on a page people read while frightened
  themeColor: "#0f766e",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
