//! What the in-app updater offers: which [Update feed] an [Update channel]
//! reads, and whether the version a feed names is worth offering at all — an
//! upgrade, a [Channel step-down], or nothing.
//!
//! Pure decisions only. The network check, the download and the restart live
//! in the Tauri shell (`src-tauri/src/update_rt.rs`).
//!
//! The version rules mirror `channelOf` and `compareVersions` in
//! `scripts/release-lib.mjs`, which name and order the builds this reads.
//! Both follow plain semver, so a change to the version shapes changes both
//! files together (ADR 0047).

use semver::Version;
use serde::{Deserialize, Serialize};

/// Which builds an installed Kriyon updates to. Ordered calmest first, so
/// `Stable < Beta < Nightly`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
    Nightly,
}

impl UpdateChannel {
    /// The channel's [Update feed]. Fixed: the feed is a trust decision, so
    /// nothing from the webview or the environment chooses it.
    #[must_use]
    pub const fn feed_url(self) -> &'static str {
        match self {
            Self::Stable => {
                "https://github.com/LeafyCode/kriyon/releases/latest/download/latest.json"
            }
            Self::Beta => {
                "https://github.com/LeafyCode/kriyon/releases/download/feed-beta/latest.json"
            }
            Self::Nightly => {
                "https://github.com/LeafyCode/kriyon/releases/download/feed-nightly/latest.json"
            }
        }
    }

    /// The channel a version was built for, from its shape: `x.y.z`,
    /// `x.y.z-beta.N` or `x.y.z-nightly.YYYYMMDD.N`. `None` for any other
    /// shape. Mirrors `channelOf` in `scripts/release-lib.mjs`.
    #[must_use]
    pub fn of_version(version: &Version) -> Option<Self> {
        if !version.build.is_empty() {
            return None;
        }
        let pre: Vec<&str> = if version.pre.is_empty() {
            Vec::new()
        } else {
            version.pre.as_str().split('.').collect()
        };
        let number = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        match pre.as_slice() {
            [] => Some(Self::Stable),
            ["beta", n] if number(n) => Some(Self::Beta),
            ["nightly", date, n] if date.len() == 8 && number(date) && number(n) => {
                Some(Self::Nightly)
            }
            _ => None,
        }
    }
}

/// The user's update settings, kept by the Rust core.
///
/// Every field has a default so a build reads settings a newer build wrote,
/// and a newer build reads an older build's: add fields, never rename or
/// remove one within a cycle (ADR 0047).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatePrefs {
    pub channel: UpdateChannel,
    /// Check 5 seconds after launch and every 6 hours.
    pub auto_check: bool,
    /// The [Skipped version]: never offered by a quiet check, still shown
    /// when the user asks.
    pub skipped: Option<String>,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
            auto_check: true,
            skipped: None,
        }
    }
}

/// What a feed's version means for the build that is running.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Offer {
    /// Nothing to show.
    Nothing,
    /// A newer version.
    Upgrade,
    /// An older version on the calmer channel the user moved to: a
    /// [Channel step-down], installed only after a clear prompt and a backup
    /// of the data folder.
    StepDown,
    /// A [Channel step-down] the older build could not survive, because its
    /// data may be too new for it: wait for the chosen channel to catch up.
    WaitForChannel,
}

impl Offer {
    /// Whether the updater should report the feed's release at all.
    #[must_use]
    pub const fn is_some(self) -> bool {
        !matches!(self, Self::Nothing)
    }

    /// Whether the offer can be installed.
    #[must_use]
    pub const fn installable(self) -> bool {
        matches!(self, Self::Upgrade | Self::StepDown)
    }
}

/// Whether a quiet check or the user asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckKind {
    Quiet,
    Asked,
}

/// What to offer when the `chosen` channel's feed names `remote` and `running`
/// is installed.
///
/// - Newer than running: an upgrade.
/// - Older, and running is a noisier build than the chosen channel (the user
///   moved nightly → beta, or beta → stable): a [Channel step-down], once.
///   Once the calmer build runs, its channel is the chosen one and the rule
///   is plain "only newer" again.
/// - A step-down more than one minor back may meet data it cannot read, so
///   it waits instead (saved data only promises the previous minor).
/// - A version noisier than the chosen channel is never offered: the stable
///   feed must not move anyone to a nightly.
/// - The [Skipped version] is offered only when the user asks.
#[must_use]
pub fn offer(running: &Version, remote: &Version, prefs: &UpdatePrefs, kind: CheckKind) -> Offer {
    let Some(remote_channel) = UpdateChannel::of_version(remote) else {
        return Offer::Nothing;
    };
    if remote_channel > prefs.channel || remote == running {
        return Offer::Nothing;
    }
    let skipped = prefs.skipped.as_deref() == Some(remote.to_string().as_str());
    if skipped && kind == CheckKind::Quiet {
        return Offer::Nothing;
    }
    if remote > running {
        return Offer::Upgrade;
    }
    // A build whose shape names no channel (a local build) counts as noisiest.
    let running_channel = UpdateChannel::of_version(running).unwrap_or(UpdateChannel::Nightly);
    if running_channel <= prefs.channel {
        return Offer::Nothing;
    }
    if reads_data_of(remote, running) {
        Offer::StepDown
    } else {
        Offer::WaitForChannel
    }
}

/// Whether a check's result still answers the prefs the user has now, given
/// the prefs it `started` under. `None`: keep it. Otherwise discard it and
/// check again, of the returned kind.
///
/// A channel change means a different feed, checked as asked, the way a
/// change made while no check runs is. A new [Skipped version] runs it again
/// quietly, even after "Check now", or the version just skipped would come
/// straight back. Auto-check changes no result.
#[must_use]
pub fn recheck(started: &UpdatePrefs, now: &UpdatePrefs) -> Option<CheckKind> {
    if started.channel != now.channel {
        Some(CheckKind::Asked)
    } else if started.skipped != now.skipped {
        Some(CheckKind::Quiet)
    } else {
        None
    }
}

/// Whether `older` can read the data `newer` wrote: the same minor, or the
/// one before it, within one major.
fn reads_data_of(older: &Version, newer: &Version) -> bool {
    older.major == newer.major && older.minor + 1 >= newer.minor
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).expect("version")
    }

    fn on(channel: UpdateChannel) -> UpdatePrefs {
        UpdatePrefs {
            channel,
            ..UpdatePrefs::default()
        }
    }

    fn quiet(running: &str, remote: &str, prefs: &UpdatePrefs) -> Offer {
        offer(&v(running), &v(remote), prefs, CheckKind::Quiet)
    }

    #[test]
    fn each_channel_reads_its_own_feed() {
        assert!(UpdateChannel::Stable
            .feed_url()
            .ends_with("/releases/latest/download/latest.json"));
        assert!(UpdateChannel::Beta
            .feed_url()
            .ends_with("/releases/download/feed-beta/latest.json"));
        assert!(UpdateChannel::Nightly
            .feed_url()
            .ends_with("/releases/download/feed-nightly/latest.json"));
        for channel in [
            UpdateChannel::Stable,
            UpdateChannel::Beta,
            UpdateChannel::Nightly,
        ] {
            assert!(channel
                .feed_url()
                .starts_with("https://github.com/LeafyCode/kriyon/"));
        }
    }

    #[test]
    fn a_version_names_its_channel_like_the_release_scripts() {
        let of = |s: &str| UpdateChannel::of_version(&v(s));
        assert_eq!(of("0.13.0"), Some(UpdateChannel::Stable));
        assert_eq!(of("0.13.0-beta.2"), Some(UpdateChannel::Beta));
        assert_eq!(
            of("0.13.0-nightly.20261017.2"),
            Some(UpdateChannel::Nightly)
        );
        assert_eq!(of("0.13.0-rc.1"), None);
        assert_eq!(of("0.13.0-beta"), None);
        assert_eq!(of("0.13.0-nightly.2026101.1"), None);
        assert_eq!(of("0.13.0+build.5"), None);
    }

    #[test]
    fn channels_order_calmest_first() {
        assert!(UpdateChannel::Stable < UpdateChannel::Beta);
        assert!(UpdateChannel::Beta < UpdateChannel::Nightly);
    }

    #[test]
    fn semver_sorts_a_nightly_after_the_beta_of_the_same_base() {
        // The case that breaks a plain "only newer" rule on a channel switch.
        assert!(v("0.13.0-nightly.20261017.1") > v("0.13.0-beta.9"));
        assert!(v("0.13.0-beta.10") > v("0.13.0-beta.9"));
        assert!(v("0.13.0") > v("0.13.0-nightly.20261017.1"));
    }

    #[test]
    fn a_newer_version_on_the_channel_is_an_upgrade() {
        assert_eq!(
            quiet("0.12.0", "0.13.0", &on(UpdateChannel::Stable)),
            Offer::Upgrade
        );
        assert_eq!(
            quiet("0.13.0-beta.1", "0.13.0-beta.2", &on(UpdateChannel::Beta)),
            Offer::Upgrade
        );
        assert_eq!(
            quiet(
                "0.13.0-nightly.20261017.1",
                "0.13.0-nightly.20261017.2",
                &on(UpdateChannel::Nightly)
            ),
            Offer::Upgrade
        );
    }

    #[test]
    fn beta_users_land_on_stable_when_it_ships() {
        assert_eq!(
            quiet("0.13.0-beta.3", "0.13.0", &on(UpdateChannel::Beta)),
            Offer::Upgrade
        );
    }

    #[test]
    fn the_same_or_an_older_version_on_the_same_channel_is_nothing() {
        let stable = on(UpdateChannel::Stable);
        assert_eq!(quiet("0.13.0", "0.13.0", &stable), Offer::Nothing);
        assert_eq!(quiet("0.13.1", "0.13.0", &stable), Offer::Nothing);
        assert_eq!(
            quiet("0.13.0-beta.3", "0.13.0-beta.2", &on(UpdateChannel::Beta)),
            Offer::Nothing
        );
    }

    #[test]
    fn a_build_noisier_than_the_chosen_channel_is_never_offered() {
        assert_eq!(
            quiet(
                "0.12.0",
                "0.13.0-nightly.20261017.1",
                &on(UpdateChannel::Stable)
            ),
            Offer::Nothing
        );
        assert_eq!(
            quiet("0.12.0", "0.13.0-beta.1", &on(UpdateChannel::Stable)),
            Offer::Nothing
        );
        assert_eq!(
            quiet(
                "0.12.0-beta.1",
                "0.13.0-nightly.20261017.1",
                &on(UpdateChannel::Beta)
            ),
            Offer::Nothing
        );
    }

    #[test]
    fn a_version_of_no_known_shape_is_never_offered() {
        assert_eq!(
            quiet("0.12.0", "0.13.0-rc.1", &on(UpdateChannel::Nightly)),
            Offer::Nothing
        );
    }

    #[test]
    fn moving_from_nightly_to_beta_offers_the_older_beta_once() {
        let beta = on(UpdateChannel::Beta);
        // Semver puts the running nightly above the beta of the same base.
        assert_eq!(
            quiet("0.13.0-nightly.20261017.2", "0.13.0-beta.2", &beta),
            Offer::StepDown
        );
        // Once the beta runs, "only newer" holds again.
        assert_eq!(
            quiet("0.13.0-beta.2", "0.13.0-beta.2", &beta),
            Offer::Nothing
        );
        assert_eq!(
            quiet("0.13.0-beta.2", "0.13.0-beta.1", &beta),
            Offer::Nothing
        );
    }

    #[test]
    fn moving_from_beta_or_nightly_to_stable_offers_the_older_stable() {
        let stable = on(UpdateChannel::Stable);
        assert_eq!(quiet("0.13.0-beta.2", "0.12.4", &stable), Offer::StepDown);
        assert_eq!(
            quiet("0.13.0-nightly.20261017.2", "0.12.4", &stable),
            Offer::StepDown
        );
    }

    #[test]
    fn a_step_down_more_than_one_minor_back_waits_for_the_channel() {
        let stable = on(UpdateChannel::Stable);
        assert_eq!(
            quiet("0.14.0-beta.1", "0.12.4", &stable),
            Offer::WaitForChannel
        );
        assert_eq!(
            quiet("1.0.0-beta.1", "0.13.0", &stable),
            Offer::WaitForChannel
        );
        assert!(Offer::WaitForChannel.is_some());
        assert!(!Offer::WaitForChannel.installable());
    }

    #[test]
    fn a_local_build_of_no_channel_steps_down_to_the_chosen_one() {
        assert_eq!(
            quiet("0.13.0-dev", "0.13.0-beta.2", &on(UpdateChannel::Beta)),
            Offer::StepDown
        );
    }

    #[test]
    fn a_skipped_version_is_hidden_from_quiet_checks_only() {
        let prefs = UpdatePrefs {
            skipped: Some("0.13.0".to_string()),
            ..UpdatePrefs::default()
        };
        assert_eq!(quiet("0.12.0", "0.13.0", &prefs), Offer::Nothing);
        assert_eq!(
            offer(&v("0.12.0"), &v("0.13.0"), &prefs, CheckKind::Asked),
            Offer::Upgrade
        );
        // A newer release than the skipped one is offered again.
        assert_eq!(quiet("0.12.0", "0.13.1", &prefs), Offer::Upgrade);
    }

    #[test]
    fn a_skipped_step_down_is_hidden_too() {
        let prefs = UpdatePrefs {
            channel: UpdateChannel::Stable,
            skipped: Some("0.12.4".to_string()),
            ..UpdatePrefs::default()
        };
        assert_eq!(quiet("0.13.0-beta.2", "0.12.4", &prefs), Offer::Nothing);
    }

    #[test]
    fn prefs_read_from_older_and_newer_builds() {
        assert_eq!(
            serde_json::from_str::<UpdatePrefs>("{}").expect("empty"),
            UpdatePrefs::default()
        );
        let newer: UpdatePrefs =
            serde_json::from_str(r#"{"channel":"beta","futureField":1}"#).expect("newer");
        assert_eq!(newer.channel, UpdateChannel::Beta);
        assert!(newer.auto_check);
    }

    #[test]
    fn a_result_under_unchanged_prefs_stands() {
        let prefs = UpdatePrefs::default();
        assert_eq!(recheck(&prefs, &prefs), None);
        let auto_off = UpdatePrefs {
            auto_check: false,
            ..UpdatePrefs::default()
        };
        assert_eq!(recheck(&prefs, &auto_off), None);
    }

    #[test]
    fn a_channel_change_mid_check_reads_the_new_feed_as_asked() {
        let started = on(UpdateChannel::Nightly);
        let now = on(UpdateChannel::Stable);
        assert_eq!(recheck(&started, &now), Some(CheckKind::Asked));
    }

    #[test]
    fn a_skip_mid_check_checks_again_quietly() {
        let started = UpdatePrefs::default();
        let now = UpdatePrefs {
            skipped: Some("0.13.0".to_string()),
            ..UpdatePrefs::default()
        };
        // Quiet, even after "Check now", so the version just skipped stays hidden.
        assert_eq!(recheck(&started, &now), Some(CheckKind::Quiet));
    }
}
