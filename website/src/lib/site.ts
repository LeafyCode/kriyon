/** Canonical origin, used to make social-card and canonical URLs absolute. */
export const SITE_URL = "https://kriyon.app";

export const GITHUB_URL = "https://github.com/LeafyCode/kriyon";
export const LEAFYCODE_URL = "https://leafycode.com/";
export const LEAFYCODE_NAME = "Leafy Code International";

/* Leafy Code International's contact details, as published on leafycode.com/contact. */
export const LEAFYCODE = {
  tagline: "Apps. Systems. Robotics. Engineered to last.",
  email: "hello@leafycode.com",
  phone: "+94 766 707 355",
  phoneHref: "tel:+94766707355",
  whatsappHref: "https://wa.me/94766707355",
  /* In parts, for the JSON-LD PostalAddress; `postalAddressLine` joins them. */
  address: {
    street: "2nd Floor, 269, 1 High Level Rd",
    locality: "Pannipitiya",
    postalCode: "10230",
    country: "Sri Lanka",
    countryCode: "LK",
  },
  mapHref:
    "https://www.google.com/maps/search/2nd+Floor+269+1+High+Level+Rd+Pannipitiya+10230",
  hours: ["Mon–Fri 09:00–18:00", "Sat 10:00–14:00", "Times in IST, UTC+5:30"],
  contactHref: "https://leafycode.com/contact",
  social: [
    { label: "GitHub", href: "https://github.com/LeafyCode" },
    { label: "X (Twitter)", href: "https://x.com/LeafyCode" },
    { label: "Facebook", href: "https://facebook.com/LeafyCode" },
    { label: "Instagram", href: "https://instagram.com/LeafyCode" },
  ],
} as const;
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
/* The newest stable DMG, whatever its version: every release also uploads
   its DMG as `Kriyon.dmg` (.github/workflows/release.yml), and GitHub's
   latest/download path serves that name from the newest stable release. */
export const LATEST_DMG_URL = `${RELEASES_URL}/latest/download/Kriyon.dmg`;
export const CHANGELOG_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const DISCUSSIONS_URL = `${GITHUB_URL}/discussions`;
export const GOOD_FIRST_ISSUES_URL = `${GITHUB_URL}/labels/good%20first%20issue`;
export const HELP_WANTED_URL = `${GITHUB_URL}/labels/help%20wanted`;

export const BREW_COMMAND = "brew install leafycode/tap/kriyon";

/* Set by `pnpm release` (rendered in the nav, rating plate and footer). */
export const APP_VERSION = "v0.13.0";

/** The studio address as one line, the way leafycode.com/contact writes it. */
export function postalAddressLine(a: typeof LEAFYCODE.address): string {
  return `${a.street}, ${a.locality} ${a.postalCode}, ${a.country}`;
}
