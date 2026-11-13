//! One owner for "a resent start gets the same session" (spec §4): a
//! [Remote device]'s `StartSession` is recorded before its shell opens, a
//! resend finds the record, and a resend arriving while the first is still
//! starting waits for it.

use std::collections::HashMap;
use std::sync::Arc;

use kriyon_remote::message::{EndpointId, RefuseReason};

use crate::store::{RemoteStartRecord, Store, StoreError};

/// A start, by the device that asked and its request id.
pub type StartKey = (EndpointId, [u8; 16]);

/// The remote starts under way, one lock each, held in `AppState`.
#[derive(Debug, Default)]
pub struct RemoteStarts {
    under_way: parking_lot::Mutex<HashMap<StartKey, Arc<tokio::sync::Mutex<()>>>>,
}

impl RemoteStarts {
    /// Run `start` for `key` alone: a resend that comes while it runs waits
    /// for it (and then finds its record), while other starts go ahead.
    pub async fn once<T>(&self, key: StartKey, start: impl std::future::Future<Output = T>) -> T {
        let lock = Arc::clone(self.under_way.lock().entry(key).or_default());
        let done = {
            let _this_request = lock.lock().await;
            start.await
        };
        drop(lock);
        // Gone once no one else waits on it.
        let mut under_way = self.under_way.lock();
        if under_way
            .get(&key)
            .is_some_and(|held| Arc::strong_count(held) == 1)
        {
            under_way.remove(&key);
        }
        done
    }

    /// How many starts have a lock now.
    #[cfg(test)]
    fn under_way(&self) -> usize {
        self.under_way.lock().len()
    }
}

/// What an earlier `StartSession` with this request id came to, within a
/// day: the session it made, or that it failed. `None` for a new request.
#[must_use]
pub fn answered(
    store: &Store,
    device: &EndpointId,
    request_id: &[u8; 16],
    now_ms: i64,
) -> Option<Result<String, RefuseReason>> {
    let record = store
        .remote_start(device, request_id, now_ms)
        .ok()
        .flatten()?;
    Some(match record {
        RemoteStartRecord::Made(session_id) => Ok(session_id),
        RemoteStartRecord::Failed => Err(RefuseReason::StartFailed),
    })
}

/// Record that this request makes session `session_id`, before its shell
/// opens, so a resend (or one after a crash) finds it; old records go.
///
/// # Errors
/// When the store can't be written.
pub fn record(
    store: &Store,
    device: &EndpointId,
    request_id: &[u8; 16],
    session_id: &str,
    now_ms: i64,
) -> Result<(), StoreError> {
    let _ = store.prune_remote_starts(now_ms);
    store.record_remote_start(device, request_id, session_id, now_ms)
}

/// The start failed: the request stays failed for the day, so a resend is
/// refused the same way, and the session's row goes.
pub fn fail(store: &Store, device: &EndpointId, request_id: &[u8; 16], session_id: &str) {
    let _ = store.fail_remote_start(device, request_id);
    let _ = store.delete_session(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const PHONE: [u8; 32] = [3; 32];

    #[test]
    fn a_resend_while_the_first_runs_waits_for_it_and_others_go_ahead() {
        tauri::async_runtime::block_on(async {
            let starts = Arc::new(RemoteStarts::default());
            let made = Arc::new(AtomicUsize::new(0));
            let (release, held) = tokio::sync::oneshot::channel::<()>();
            let first = {
                let (starts, made) = (Arc::clone(&starts), Arc::clone(&made));
                tokio::spawn(async move {
                    starts
                        .once((PHONE, [1; 16]), async {
                            let _ = held.await;
                            made.fetch_add(1, Ordering::SeqCst)
                        })
                        .await
                })
            };
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            // Another request goes ahead at once.
            let other = starts.once((PHONE, [2; 16]), async { 99 }).await;
            assert_eq!(other, 99);
            // The resend waits for the first, then runs after it.
            let resend = {
                let (starts, made) = (Arc::clone(&starts), Arc::clone(&made));
                tokio::spawn(async move {
                    starts
                        .once((PHONE, [1; 16]), async { made.load(Ordering::SeqCst) })
                        .await
                })
            };
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            assert!(!resend.is_finished(), "waits for the first");
            let _ = release.send(());
            assert_eq!(first.await.expect("first"), 0);
            assert_eq!(resend.await.expect("resend"), 1, "after the first made it");
            assert_eq!(starts.under_way(), 0, "nothing left behind");
        });
    }
}
