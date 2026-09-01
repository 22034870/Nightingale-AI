import type { MetadataRoute } from "next";

// PWA manifest. The brief requires a mobile-responsive PWA; this plus the
// viewport settings in layout.tsx is the whole requirement in Next.js.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nightingale",
    short_name: "Nightingale",
    description:
      "Ask a clinic a question. No account needed to start.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f766e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
