/* The two faces the first screenful actually paints in. Without these they are
   discovered only after `styles.css` parses, one round-trip too late. */
import archivoUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import monoUrl from "@fontsource-variable/spline-sans-mono/files/spline-sans-mono-latin-wght-normal.woff2?url";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import {
  APP_VERSION,
  GITHUB_URL,
  LATEST_DMG_URL,
  LEAFYCODE,
  LEAFYCODE_NAME,
  LEAFYCODE_URL,
  SITE_URL,
} from "../lib/site.ts";
import {
  reapplyPinnedTheme,
  THEME_COLORS,
  THEME_SCRIPT,
} from "../lib/theme.ts";
import appCss from "../styles.css?url";

/* Sized for search results: the title under 60 characters, the description
   under 160, so neither is cut off. */
const TITLE = "Kriyon — the desktop home for Claude Code";
const DESCRIPTION =
  "Run every Claude Code session, across every project, in one window. See which one needs you and what each one changed. Free and open source.";
/* Social cards lead with the tagline; search results lead with what it is. */
const SOCIAL_TITLE = "Kriyon — Run them all. Watch one screen.";
const SOCIAL_DESCRIPTION = `The desktop home for Claude Code: every session in one window, which one needs you, and what each one changed. Free and open source, by ${LEAFYCODE_NAME}.`;
/* Purpose-built 1200x630 JPEG: absolute URL, and a format every scraper renders
   (LinkedIn will not unfurl a WebP, and the 3600px hero crops badly at 1.91:1). */
const SOCIAL_IMAGE = `${SITE_URL}/og.jpg`;
const SOCIAL_IMAGE_ALT =
  "Kriyon: Run them all. Watch one screen. A Claude Code session with its Activity record marking files changed, tests passed and web requests.";

/* Structured data for search engines: the app, and the company behind it
   with the contact details from leafycode.com/contact. */
const LEAFYCODE_ORG = {
  "@type": "Organization",
  name: LEAFYCODE_NAME,
  url: LEAFYCODE_URL,
  logo: `${SITE_URL}/leafycode-logo.svg`,
  email: LEAFYCODE.email,
  telephone: LEAFYCODE.phone,
  address: {
    "@type": "PostalAddress",
    streetAddress: LEAFYCODE.address.street,
    addressLocality: LEAFYCODE.address.locality,
    postalCode: LEAFYCODE.address.postalCode,
    addressCountry: LEAFYCODE.address.countryCode,
  },
  sameAs: LEAFYCODE.social.map((s) => s.href),
};
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Kriyon",
  url: `${SITE_URL}/`,
  description: DESCRIPTION,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS 13 or later",
  softwareVersion: APP_VERSION.replace("v", ""),
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  downloadUrl: LATEST_DMG_URL,
  codeRepository: GITHUB_URL,
  image: SOCIAL_IMAGE,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: LEAFYCODE_ORG,
  publisher: LEAFYCODE_ORG,
};

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "author", content: LEAFYCODE_NAME },
      {
        name: "robots",
        content: "index, follow, max-image-preview:large",
      },
      { name: "color-scheme", content: "light dark" },
      { property: "og:title", content: SOCIAL_TITLE },
      { property: "og:description", content: SOCIAL_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE_URL}/` },
      { property: "og:site_name", content: "Kriyon" },
      { property: "og:locale", content: "en_US" },
      { property: "og:image", content: SOCIAL_IMAGE },
      { property: "og:image:type", content: "image/jpeg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: SOCIAL_IMAGE_ALT,
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@LeafyCode" },
      { name: "twitter:title", content: SOCIAL_TITLE },
      { name: "twitter:description", content: SOCIAL_DESCRIPTION },
      { name: "twitter:image", content: SOCIAL_IMAGE },
      { name: "twitter:image:alt", content: SOCIAL_IMAGE_ALT },
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
      { rel: "icon", href: "/logo-steel.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(STRUCTURED_DATA),
      },
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
  // Once hydrated, every page puts a pinned theme's bar colour back in front:
  // in development React moves the tags it renders ahead of it.
  useEffect(() => {
    reapplyPinnedTheme();
  }, []);

  return (
    // The theme script below sets `data-theme` before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Written here, not in `head()`: its meta merge keeps one tag per
            name, and the browser bar needs one colour per scheme. A pinned
            theme adds its own tag ahead of these (lib/theme.ts). */}
        <meta
          content={THEME_COLORS.light}
          media="(prefers-color-scheme: light)"
          name="theme-color"
        />
        <meta
          content={THEME_COLORS.dark}
          media="(prefers-color-scheme: dark)"
          name="theme-color"
        />
        <ScriptOnce>{THEME_SCRIPT}</ScriptOnce>
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
