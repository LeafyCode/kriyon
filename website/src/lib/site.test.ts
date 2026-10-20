import { expect, test } from "vitest";
import robots from "../../public/robots.txt?raw";
import sitemap from "../../public/sitemap.xml?raw";
import { SITE_URL } from "./site.ts";

// robots.txt and sitemap.xml are static files in public/, so each holds its
// own copy of the site's origin; this keeps them on the one in site.ts.

test("the site lives at kriyonapp.com", () => {
  expect(SITE_URL).toBe("https://kriyonapp.com");
});

test("robots.txt and the sitemap point at the site's own origin", () => {
  expect(robots).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  expect(sitemap).toContain(`<loc>${SITE_URL}/</loc>`);
});
