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
  address: "2nd Floor, 269, 1 High Level Rd, Pannipitiya 10230, Sri Lanka",
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
export const CHANGELOG_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const DISCUSSIONS_URL = `${GITHUB_URL}/discussions`;
export const GOOD_FIRST_ISSUES_URL = `${GITHUB_URL}/labels/good%20first%20issue`;
export const HELP_WANTED_URL = `${GITHUB_URL}/labels/help%20wanted`;

export const BREW_COMMAND = "brew install leafycode/tap/kriyon";

/* Set by `pnpm release` (rendered in the nav, rating plate and footer). */
export const APP_VERSION = "v0.13.0";
