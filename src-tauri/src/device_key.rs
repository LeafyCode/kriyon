//! The host's [Device key]: made once, kept in the keychain, never synced or
//! sent. Its public half is the host's iroh endpoint id, which every paired
//! device stores, so losing or replacing it unpairs them all; a stored key
//! that doesn't read back is an error, never silently replaced.
//!
//! Kept in the data-protection keychain, readable only while this Mac is
//! unlocked and never leaving it, when the app is entitled to it (a signed
//! build with a provisioning profile). Otherwise it falls back to the login
//! keychain, which is never synced either and is readable while the person is
//! logged in, by this app only.

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
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum DeviceKeyError {
    #[error("the keychain can't be reached: {0}")]
    Vault(String),
    /// A stored key that isn't 32 bytes. Replacing it would unpair every
    /// device, so it is left for the person to deal with.
    #[error("the stored device key is damaged ({0} bytes)")]
    Damaged(usize),
}

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
#[cfg(target_os = "macos")]
pub struct Keychain {
    service: String,
    account: &'static str,
}

#[cfg(target_os = "macos")]
impl Keychain {
    /// The device key's item for the app with bundle identifier `identifier`.
    #[must_use]
    pub fn for_app(identifier: &str) -> Self {
        Self::item(identifier, "device-key")
    }

    /// The item `account` for the app with bundle identifier `identifier`.
    #[must_use]
    pub fn item(identifier: &str, account: &'static str) -> Self {
        Self {
            service: format!("{identifier}.remote"),
            account,
        }
    }

    fn protected(&self) -> security_framework::passwords::PasswordOptions {
        let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
            &self.service,
            self.account,
        );
        options.use_protected_keychain();
        options
    }
}

/// `errSecMissingEntitlement`: the app isn't entitled to the
/// data-protection keychain (no provisioning profile).
#[cfg(target_os = "macos")]
const MISSING_ENTITLEMENT: i32 = -34018;

/// `errSecItemNotFound`.
#[cfg(target_os = "macos")]
const NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
impl KeyVault for Keychain {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        SecretVault::read(self)
    }

    fn write(&self, secret: &[u8; 32]) -> Result<(), String> {
        SecretVault::write(self, secret)
    }
}

#[cfg(target_os = "macos")]
impl SecretVault for Keychain {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        use security_framework::passwords::{generic_password, get_generic_password};
        // Not entitled, or entitled but kept in the login keychain by an
        // earlier build: look there too, so a build that gains the
        // entitlement never makes a second key and unpairs every device.
        let found = match generic_password(self.protected()) {
            Err(e) if e.code() == MISSING_ENTITLEMENT || e.code() == NOT_FOUND => {
                get_generic_password(&self.service, self.account)
            }
            other => other,
        };
        match found {
            Ok(secret) => Ok(Some(secret)),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        use security_framework::access_control::{ProtectionMode, SecAccessControl};
        use security_framework::passwords::{set_generic_password, set_generic_password_options};
        let mut options = self.protected();
        // Readable only while this Mac is unlocked, and never leaves it.
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|e| e.to_string())?;
        options.set_access_control(access);
        options.set_access_synchronized(Some(false));
        match set_generic_password_options(secret, options) {
            Err(e) if e.code() == MISSING_ENTITLEMENT => {
                eprintln!(
                    "kriyon: no data-protection keychain for this build; {} goes in the login \
                     keychain, which is never synced",
                    self.account
                );
                set_generic_password(&self.service, self.account, secret).map_err(|e| e.to_string())
            }
            other => other.map_err(|e| e.to_string()),
        }
    }

    fn remove(&self) -> Result<(), String> {
        use security_framework::passwords::{
            delete_generic_password, delete_generic_password_options,
        };
        // Both places it may be kept (see `read`); missing from either is fine.
        let gone = |result: security_framework::base::Result<()>| match result {
            Err(e) if e.code() != NOT_FOUND && e.code() != MISSING_ENTITLEMENT => {
                Err(e.to_string())
            }
            _ => Ok(()),
        };
        gone(delete_generic_password_options(self.protected()))?;
        gone(delete_generic_password(&self.service, self.account))
    }
}

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
