/* The two faces the first screenful actually paints in. Without these they are
   discovered only after `styles.css` parses, one round-trip too late. */
import archivoUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import monoUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SITE_URL } from "../lib/site.ts";
import appCss from "../styles.css?url";

const TITLE = "Kriyon — Run ten Claude Code sessions. Stay one person.";
const DESCRIPTION =
  "Kriyon wraps your own claude command line in a calm, cinematic macOS window. Run many sessions across projects, see exactly what each one changed, and know the moment one needs you. Free and open source, by Leafy Code International.";
const SOCIAL_DESCRIPTION =
  "A calm, cinematic macOS window around your own claude CLI. Free and open source, by Leafy Code International.";
/* Purpose-built 1200x630 JPEG: absolute URL, and a format every scraper renders
   (LinkedIn will not unfurl a WebP, and the 3600px hero crops badly at 1.91:1). */
const SOCIAL_IMAGE = `${SITE_URL}/og.jpg`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#05060b" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: SOCIAL_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE_URL}/` },
      { property: "og:site_name", content: "Kriyon" },
      { property: "og:image", content: SOCIAL_IMAGE },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: "Kriyon running several Claude Code sessions in one window",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: SOCIAL_DESCRIPTION },
      { name: "twitter:image", content: SOCIAL_IMAGE },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: archivoUrl,
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: monoUrl,
        crossOrigin: "anonymous",
      },
      { rel: "canonical", href: `${SITE_URL}/` },
      { rel: "icon", href: "/logo-purple.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
