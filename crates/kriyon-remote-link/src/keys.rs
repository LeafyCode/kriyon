//! Where a [Device key] and the app's other secrets are kept, as traits the
//! app provides: the Mac's keychain on the desktop, the phone's secure store
//! on the phone. A stored key that doesn't read back is an error, never
//! silently replaced: its public half is the endpoint id every paired peer
//! stores.
/// Where a device key is kept.
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

/// The macOS keychain, under `<bundle identifier>.remote` / an item name
/// (`device-key` for the device key).
#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[derive(Default)]
    struct Memory {
        stored: RefCell<Option<Vec<u8>>>,
        writes: RefCell<u32>,
        broken: bool,
    }

    impl KeyVault for Memory {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            if self.broken {
                return Err("locked".into());
            }
            Ok(self.stored.borrow().clone())
        }
        fn write(&self, secret: &[u8; 32]) -> Result<(), String> {
            *self.writes.borrow_mut() += 1;
            *self.stored.borrow_mut() = Some(secret.to_vec());
            Ok(())
        }
    }

    #[test]
    fn the_first_start_makes_a_key_and_keeps_it() {
        let vault = Memory::default();
        assert_eq!(load_or_create(&vault, || [7; 32]), Ok([7; 32]));
        assert_eq!(*vault.stored.borrow(), Some(vec![7; 32]));
    }

    #[test]
    fn later_starts_use_the_same_key() {
        let vault = Memory::default();
        load_or_create(&vault, || [7; 32]).expect("made");
        assert_eq!(
            load_or_create(&vault, || panic!("never a second key")),
            Ok([7; 32])
        );
        assert_eq!(*vault.writes.borrow(), 1);
    }

    #[test]
    fn a_damaged_key_is_an_error_and_is_left_alone() {
        let vault = Memory {
            stored: RefCell::new(Some(vec![1; 5])),
            ..Memory::default()
        };
        assert_eq!(
            load_or_create(&vault, || panic!("never replaced")),
            Err(DeviceKeyError::Damaged(5))
        );
        assert_eq!(*vault.writes.borrow(), 0);
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
}
