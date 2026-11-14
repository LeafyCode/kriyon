//! Where a [Device key] and the app's other secrets are kept, as traits the
//! app provides: the Mac's keychain on the desktop, the phone's secure store
//! on the phone. A stored key that doesn't read back is an error, never
//! silently replaced: its public half is the endpoint id every paired peer
//! stores.
#[cfg(windows)]
pub mod windows;

/// Where a device key is kept: any [`SecretVault`] is one (stores implement
/// that one trait); [`load_or_create`] checks the key is 32 bytes.
pub trait KeyVault {
    /// The stored secret, or `None` when there is none yet.
    ///
    /// # Errors
    /// Why the vault couldn't be read.
    fn read(&self) -> Result<Option<Vec<u8>>, String>;

    /// Keep `secret`.
    ///
    /// # Errors
    /// Why the vault couldn't be written.
    fn write(&self, secret: &[u8; 32]) -> Result<(), String>;
}

/// Where any other secret of the app is kept, by itself: bytes that can be
/// replaced or removed.
pub trait SecretVault: Send + Sync {
    /// The stored secret, or `None` when there is none.
    ///
    /// # Errors
    /// Why the vault couldn't be read.
    fn read(&self) -> Result<Option<Vec<u8>>, String>;

    /// Keep `secret`, replacing what was there.
    ///
    /// # Errors
    /// Why the vault couldn't be written.
    fn write(&self, secret: &[u8]) -> Result<(), String>;

    /// Remove the secret; nothing stored is fine.
    ///
    /// # Errors
    /// Why the vault couldn't be written.
    fn remove(&self) -> Result<(), String>;
}

impl<T: SecretVault + ?Sized> KeyVault for T {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        SecretVault::read(self)
    }

    fn write(&self, secret: &[u8; 32]) -> Result<(), String> {
        SecretVault::write(self, secret)
    }
}

/// Why the device key couldn't be had.
#[derive(Debug, PartialEq, Eq)]
pub enum DeviceKeyError {
    Vault(String),
    /// A stored key that isn't 32 bytes. Replacing it would unpair every
    /// device, so it is left for the person to deal with.
    Damaged(usize),
}

impl std::fmt::Display for DeviceKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Vault(why) => write!(f, "the keychain can't be reached: {why}"),
            Self::Damaged(len) => write!(f, "the stored device key is damaged ({len} bytes)"),
        }
    }
}

impl std::error::Error for DeviceKeyError {}

/// The device key: the stored one, or a new one from `generate`, kept before
/// it is returned.
///
/// # Errors
/// [`DeviceKeyError`].
pub fn load_or_create(
    vault: &dyn KeyVault,
    generate: impl FnOnce() -> [u8; 32],
) -> Result<[u8; 32], DeviceKeyError> {
    if let Some(stored) = vault.read().map_err(DeviceKeyError::Vault)? {
        let len = stored.len();
        return stored.try_into().map_err(|_| DeviceKeyError::Damaged(len));
    }
    let secret = generate();
    vault.write(&secret).map_err(DeviceKeyError::Vault)?;
    Ok(secret)
}

/// A secret kept in `small` while it is at most `limit` bytes, and in
/// `large` when it is bigger: Windows' Credential Manager holds 2,560 bytes
/// a credential, and the relay sign-in can be longer. Either way it is kept
/// in one of them only.
pub struct SizedVault<S, L> {
    pub small: S,
    pub large: L,
    pub limit: usize,
}

impl<S: SecretVault, L: SecretVault> SecretVault for SizedVault<S, L> {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        match self.small.read()? {
            Some(secret) => Ok(Some(secret)),
            None => self.large.read(),
        }
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        if secret.len() <= self.limit {
            // `small` is read first, so an old large copy can't shadow it:
            // clearing it is tidying, and its failure doesn't undo the write.
            self.small.write(secret)?;
            let _ = self.large.remove();
            Ok(())
        } else {
            // Cleared first, so an old small copy never shadows the new one;
            // stopped between, the secret is gone, never stale.
            self.small.remove()?;
            self.large.write(secret)
        }
    }

    fn remove(&self) -> Result<(), String> {
        self.small.remove()?;
        self.large.remove()
    }
}

/// The macOS keychain, under `<bundle identifier>.remote` / an item name
/// (`device-key` for the device key).
#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A store in memory: one trait, [`SecretVault`], makes it a key vault.
    #[derive(Default)]
    struct Memory {
        stored: Mutex<Option<Vec<u8>>>,
        writes: Mutex<u32>,
        broken: bool,
    }

    impl Memory {
        fn held(&self) -> Option<Vec<u8>> {
            self.stored.lock().expect("store").clone()
        }
        fn writes(&self) -> u32 {
            *self.writes.lock().expect("writes")
        }
    }

    impl SecretVault for Memory {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            if self.broken {
                return Err("locked".into());
            }
            Ok(self.held())
        }
        fn write(&self, secret: &[u8]) -> Result<(), String> {
            *self.writes.lock().expect("writes") += 1;
            *self.stored.lock().expect("store") = Some(secret.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), String> {
            *self.stored.lock().expect("store") = None;
            Ok(())
        }
    }

    #[test]
    fn the_first_start_makes_a_key_and_keeps_it() {
        let vault = Memory::default();
        assert_eq!(load_or_create(&vault, || [7; 32]), Ok([7; 32]));
        assert_eq!(vault.held(), Some(vec![7; 32]));
    }

    #[test]
    fn later_starts_use_the_same_key() {
        let vault = Memory::default();
        load_or_create(&vault, || [7; 32]).expect("made");
        assert_eq!(
            load_or_create(&vault, || panic!("never a second key")),
            Ok([7; 32])
        );
        assert_eq!(vault.writes(), 1);
    }

    #[test]
    fn a_damaged_key_is_an_error_and_is_left_alone() {
        let vault = Memory {
            stored: Mutex::new(Some(vec![1; 5])),
            ..Memory::default()
        };
        assert_eq!(
            load_or_create(&vault, || panic!("never replaced")),
            Err(DeviceKeyError::Damaged(5))
        );
        assert_eq!(vault.writes(), 0);
    }

    #[test]
    fn a_vault_that_cannot_be_read_is_an_error_not_a_new_key() {
        let vault = Memory {
            broken: true,
            ..Memory::default()
        };
        assert!(matches!(
            load_or_create(&vault, || panic!("never made")),
            Err(DeviceKeyError::Vault(_))
        ));
    }

    type Log = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    /// A store in memory, logging what was done to it.
    struct Store {
        name: &'static str,
        stored: std::sync::Mutex<Option<Vec<u8>>>,
        log: Log,
    }

    impl Store {
        fn named(name: &'static str, log: &Log) -> Self {
            Self {
                name,
                stored: std::sync::Mutex::default(),
                log: std::sync::Arc::clone(log),
            }
        }

        fn held(&self) -> Option<Vec<u8>> {
            self.stored.lock().expect("store").clone()
        }
    }

    impl SecretVault for Store {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.held())
        }
        fn write(&self, secret: &[u8]) -> Result<(), String> {
            self.log
                .lock()
                .expect("log")
                .push(format!("{} write", self.name));
            *self.stored.lock().expect("store") = Some(secret.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), String> {
            self.log
                .lock()
                .expect("log")
                .push(format!("{} remove", self.name));
            *self.stored.lock().expect("store") = None;
            Ok(())
        }
    }

    fn sized(log: &Log) -> SizedVault<Store, Store> {
        SizedVault {
            small: Store::named("small", log),
            large: Store::named("large", log),
            limit: 4,
        }
    }

    fn taken(log: &Log) -> Vec<String> {
        std::mem::take(&mut *log.lock().expect("log"))
    }

    #[test]
    fn a_secret_that_fits_is_kept_small_and_a_bigger_one_large() {
        let log = Log::default();
        let vault = sized(&log);
        SecretVault::write(&vault, &[1; 4]).expect("kept");
        assert_eq!(vault.small.held(), Some(vec![1; 4]));
        assert_eq!(vault.large.held(), None);
        assert_eq!(SecretVault::read(&vault), Ok(Some(vec![1; 4])));
        SecretVault::write(&vault, &[2; 5]).expect("kept");
        assert_eq!(vault.small.held(), None);
        assert_eq!(vault.large.held(), Some(vec![2; 5]));
        assert_eq!(SecretVault::read(&vault), Ok(Some(vec![2; 5])));
    }

    #[test]
    fn going_large_clears_small_first_so_an_old_secret_never_shadows_the_new() {
        let log = Log::default();
        let vault = sized(&log);
        SecretVault::write(&vault, &[1; 4]).expect("kept");
        taken(&log);
        SecretVault::write(&vault, &[2; 5]).expect("kept");
        assert_eq!(taken(&log), ["small remove", "large write"]);
        SecretVault::write(&vault, &[3; 4]).expect("kept");
        assert_eq!(taken(&log), ["small write", "large remove"]);
    }

    #[test]
    fn removing_clears_both_and_nothing_reads_back() {
        let log = Log::default();
        let vault = sized(&log);
        SecretVault::write(&vault, &[2; 5]).expect("kept");
        SecretVault::remove(&vault).expect("removed");
        assert_eq!(SecretVault::read(&vault), Ok(None));
    }
}
