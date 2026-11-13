//! The computers this phone paired with, as the phone's store keeps them:
//! one list under one key, as JSON. Not secret, but kept in the same store
//! as the device key so there is one place to look.

use serde::{Deserialize, Serialize};

/// The store key of the list.
pub const HOSTS_KEY: &str = "hosts";

/// A computer this phone paired with: what it needs to reach it again.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, uniffi::Record)]
pub struct PairedHost {
    /// Its endpoint id, 64 lowercase hex digits.
    pub host_id: String,
    pub name: String,
    /// `ip:port`, as the pairing code gave them.
    pub addrs: Vec<String>,
    pub relay_url: Option<String>,
    /// Unix milliseconds.
    pub paired_at_ms: i64,
}

/// The list kept under [`HOSTS_KEY`]; nothing kept reads as none.
///
/// # Errors
/// A kept list that doesn't read as one: an error, never an empty list that
/// the next pairing would write over.
pub fn read_hosts(bytes: Option<&[u8]>) -> Result<Vec<PairedHost>, String> {
    match bytes {
        None => Ok(Vec::new()),
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|_| "the list of paired computers doesn't read".to_string()),
    }
}

/// The list with `host` in it, replacing a host with the same id.
#[must_use]
pub fn with_host(hosts: Vec<PairedHost>, host: PairedHost) -> Vec<PairedHost> {
    let mut hosts = without_host(hosts, &host.host_id);
    hosts.push(host);
    hosts
}

/// The list without `host_id`.
#[must_use]
pub fn without_host(hosts: Vec<PairedHost>, host_id: &str) -> Vec<PairedHost> {
    hosts
        .into_iter()
        .filter(|host| host.host_id != host_id)
        .collect()
}

/// The list as kept.
#[must_use]
pub fn hosts_bytes(hosts: &[PairedHost]) -> Vec<u8> {
    // A list of plain records always serializes.
    serde_json::to_vec(hosts).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, name: &str) -> PairedHost {
        PairedHost {
            host_id: id.into(),
            name: name.into(),
            addrs: vec!["192.168.1.20:41641".into()],
            relay_url: None,
            paired_at_ms: 1,
        }
    }

    #[test]
    fn the_list_round_trips_and_nothing_kept_is_empty() {
        assert_eq!(read_hosts(None), Ok(Vec::new()));
        let hosts = vec![host("a", "Mac"), host("b", "Studio")];
        assert_eq!(read_hosts(Some(&hosts_bytes(&hosts))), Ok(hosts));
        assert!(
            read_hosts(Some(b"not json")).is_err(),
            "a damaged list is an error, never an empty one to write over"
        );
    }

    #[test]
    fn pairing_again_replaces_the_host_and_forgetting_removes_it() {
        let hosts = with_host(vec![host("a", "Mac")], host("b", "Studio"));
        let hosts = with_host(hosts, host("a", "Mac renamed"));
        assert_eq!(hosts.len(), 2);
        assert_eq!(
            hosts
                .iter()
                .find(|h| h.host_id == "a")
                .map(|h| h.name.as_str()),
            Some("Mac renamed")
        );
        let hosts = without_host(hosts, "a");
        assert_eq!(hosts, vec![host("b", "Studio")]);
    }
}
