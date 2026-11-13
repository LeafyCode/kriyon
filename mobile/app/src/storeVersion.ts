/**
 * The version the app stores take: the release's x.y.z. A pre-release's
 * suffix (`-beta.2`, `-nightly.…`) and build metadata (`+…`) are dropped;
 * each build's own number (build number, version code) is EAS's.
 */
const PRE_RELEASE = /[-+].*$/;

export function storeVersion(version: string): string {
  return version.replace(PRE_RELEASE, "");
}
