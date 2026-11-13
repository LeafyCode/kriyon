//! A secret kept in the desktop's keyring (on Linux, the Secret Service:
//! GNOME Keyring, or `KWallet` with its Secret Service on), as the app's
//! [`SecretVault`]. One item per secret, found by the app's identifier and
//! the secret's name. A keyring that is missing or locked is an error in
//! plain words, never a prompt the app waits on: the desktop unlocks its
//! keyring at login. The secret is never kept anywhere else, such as a file.

use kriyon_remote_link::keys::{KeyVault, SecretVault};

/// Why the keyring couldn't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyringError {
    /// No keyring on this desktop (no Secret Service on the session bus).
    Missing,
    /// A keyring, but no default one to keep a new secret in.
    NoDefault,
    /// The keyring is locked.
    Locked,
    /// Anything else, in the keyring's words.
    Failed(String),
}

/// The keyring's few operations, on the item with `attributes`.
pub trait Keyring: Send + Sync {
    /// The item's secret, or `None` when there is no such item.
    ///
    /// # Errors
    /// Why the keyring couldn't be read.
    fn get(&self, attributes: &[(&str, &str)]) -> Result<Option<Vec<u8>>, KeyringError>;

    /// Keep `secret` in the item, replacing what was there.
    ///
    /// # Errors
    /// Why the keyring couldn't be written.
    fn set(
        &self,
        label: &str,
        attributes: &[(&str, &str)],
        secret: &[u8],
    ) -> Result<(), KeyringError>;

    /// Remove the item; none is fine.
    ///
    /// # Errors
    /// Why the keyring couldn't be written.
    fn delete(&self, attributes: &[(&str, &str)]) -> Result<(), KeyringError>;
}

/// The words a [`KeyringError`] is shown in.
fn words(error: KeyringError) -> String {
    match error {
        KeyringError::Missing => "this desktop has no keyring (Secret Service) to keep remote \
             access's keys in: start one, such as GNOME Keyring, or turn on KWallet's Secret \
             Service"
            .to_string(),
        KeyringError::NoDefault => "the keyring has no default keyring to keep remote access's \
             keys in: make one in your keyring app (such as Passwords and Keys), then try again"
            .to_string(),
        KeyringError::Locked => "the keyring is locked: unlock it, then try again".to_string(),
        KeyringError::Failed(reason) => format!("the keyring failed: {reason}"),
    }
}

/// The secret `account` of the app `identifier`, kept by `keyring`.
pub struct KeyringVault<K> {
    keyring: K,
    application: String,
    account: &'static str,
}

impl<K: Keyring> KeyringVault<K> {
    #[must_use]
    pub fn new(keyring: K, identifier: &str, account: &'static str) -> Self {
        Self {
            keyring,
            application: format!("{identifier}.remote"),
            account,
        }
    }

    fn attributes(&self) -> [(&str, &str); 2] {
        [
            ("application", &self.application),
            ("account", self.account),
        ]
    }
}

impl<K: Keyring> SecretVault for KeyringVault<K> {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        self.keyring.get(&self.attributes()).map_err(words)
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        let label = format!("Kriyon remote access: {}", self.account);
        self.keyring
            .set(&label, &self.attributes(), secret)
            .map_err(words)
    }

    fn remove(&self) -> Result<(), String> {
        self.keyring.delete(&self.attributes()).map_err(words)
    }
}

impl<K: Keyring> KeyVault for KeyringVault<K> {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        SecretVault::read(self)
    }

    fn write(&self, secret: &[u8; 32]) -> Result<(), String> {
        SecretVault::write(self, secret)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use parking_lot::Mutex;

    use super::*;

    /// Items by their attributes: label and secret.
    type Items = HashMap<Vec<(String, String)>, (String, Vec<u8>)>;

    /// A keyring in memory, which can be missing or locked.
    #[derive(Default)]
    struct Fake {
        items: Mutex<Items>,
        refuse: Option<KeyringError>,
    }

    fn key(attributes: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut key: Vec<_> = attributes
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        key.sort();
        key
    }

    impl Keyring for &Fake {
        fn get(&self, attributes: &[(&str, &str)]) -> Result<Option<Vec<u8>>, KeyringError> {
            if let Some(error) = &self.refuse {
                return Err(error.clone());
            }
            Ok(self
                .items
                .lock()
                .get(&key(attributes))
                .map(|(_, secret)| secret.clone()))
        }

        fn set(
            &self,
            label: &str,
            attributes: &[(&str, &str)],
            secret: &[u8],
        ) -> Result<(), KeyringError> {
            if let Some(error) = &self.refuse {
                return Err(error.clone());
            }
            self.items
                .lock()
                .insert(key(attributes), (label.to_string(), secret.to_vec()));
            Ok(())
        }

        fn delete(&self, attributes: &[(&str, &str)]) -> Result<(), KeyringError> {
            if let Some(error) = &self.refuse {
                return Err(error.clone());
            }
            self.items.lock().remove(&key(attributes));
            Ok(())
        }
    }

    const APP: &str = "com.leafycode.kriyon";

    #[test]
    fn a_secret_kept_reads_back_and_one_never_kept_is_none() {
        let fake = Fake::default();
        let vault = KeyringVault::new(&fake, APP, "device-key");
        assert_eq!(SecretVault::read(&vault), Ok(None));
        SecretVault::write(&vault, &[7; 32]).expect("kept");
        assert_eq!(SecretVault::read(&vault), Ok(Some(vec![7; 32])));
    }

    #[test]
    fn each_secret_is_its_own_item_named_for_the_app() {
        let fake = Fake::default();
        let key_vault = KeyringVault::new(&fake, APP, "device-key");
        let relay_vault = KeyringVault::new(&fake, APP, "relay");
        SecretVault::write(&key_vault, &[1]).expect("kept");
        SecretVault::write(&relay_vault, &[2]).expect("kept");
        assert_eq!(SecretVault::read(&key_vault), Ok(Some(vec![1])));
        assert_eq!(SecretVault::read(&relay_vault), Ok(Some(vec![2])));
        let items = fake.items.lock();
        let (label, _) = items
            .get(&key(&[
                ("application", "com.leafycode.kriyon.remote"),
                ("account", "relay"),
            ]))
            .expect("the relay's item");
        assert_eq!(label, "Kriyon remote access: relay");
    }

    #[test]
    fn removing_drops_it_and_removing_nothing_is_fine() {
        let fake = Fake::default();
        let vault = KeyringVault::new(&fake, APP, "relay");
        SecretVault::write(&vault, &[2]).expect("kept");
        SecretVault::remove(&vault).expect("removed");
        assert_eq!(SecretVault::read(&vault), Ok(None));
        SecretVault::remove(&vault).expect("nothing to remove");
    }

    #[test]
    fn a_missing_keyring_says_so_and_keeps_nothing_anywhere() {
        let fake = Fake {
            refuse: Some(KeyringError::Missing),
            ..Fake::default()
        };
        let vault = KeyringVault::new(&fake, APP, "device-key");
        let read = SecretVault::read(&vault).expect_err("no keyring");
        assert!(read.contains("no keyring"), "{read}");
        let write = SecretVault::write(&vault, &[7; 32]).expect_err("no keyring");
        assert!(write.contains("GNOME Keyring"), "{write}");
        assert!(fake.items.lock().is_empty());
    }

    #[test]
    fn a_keyring_with_no_default_says_to_make_one() {
        let fake = Fake {
            refuse: Some(KeyringError::NoDefault),
            ..Fake::default()
        };
        let vault = KeyringVault::new(&fake, APP, "device-key");
        let write = SecretVault::write(&vault, &[7; 32]).expect_err("no default");
        assert!(write.contains("no default keyring"), "{write}");
        assert!(fake.items.lock().is_empty());
    }

    #[test]
    fn a_locked_keyring_says_to_unlock_it() {
        let fake = Fake {
            refuse: Some(KeyringError::Locked),
            ..Fake::default()
        };
        let vault = KeyringVault::new(&fake, APP, "device-key");
        let read = SecretVault::read(&vault).expect_err("locked");
        assert!(read.contains("locked: unlock it"), "{read}");
    }

    #[test]
    fn the_device_key_is_made_once_and_kept() {
        let fake = Fake::default();
        let vault = KeyringVault::new(&fake, APP, "device-key");
        let made = kriyon_remote_link::keys::load_or_create(&vault, || [9; 32]).expect("made");
        let again = kriyon_remote_link::keys::load_or_create(&vault, || [1; 32]).expect("read");
        assert_eq!(made, [9; 32]);
        assert_eq!(again, [9; 32]);
    }
}

/// The Secret Service on the session bus (GNOME Keyring, `KWallet`): Linux's
/// keyring. Each call connects anew and encrypts the secret in transit. It
/// never asks to unlock: a locked item or keyring is [`KeyringError::Locked`],
/// so nothing waits on a prompt.
#[cfg(target_os = "linux")]
pub struct SecretServiceKeyring;

#[cfg(target_os = "linux")]
mod secret_service_keyring {
    use std::collections::HashMap;

    use secret_service::blocking::SecretService;
    use secret_service::{EncryptionType, Error};

    use super::{Keyring, KeyringError, SecretServiceKeyring};

    /// D-Bus's answer when nothing owns the Secret Service's name.
    const NO_SERVICE: [&str; 2] = [
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
    ];

    fn failed(error: Error) -> KeyringError {
        match error {
            Error::Unavailable => KeyringError::Missing,
            Error::Zbus(zbus::Error::MethodError(name, _, _))
                if NO_SERVICE.contains(&name.as_str()) =>
            {
                KeyringError::Missing
            }
            Error::Locked | Error::Prompt | Error::PromptDisconnected => KeyringError::Locked,
            other => KeyringError::Failed(other.to_string()),
        }
    }

    fn service() -> Result<SecretService<'static>, KeyringError> {
        SecretService::connect(EncryptionType::Dh).map_err(failed)
    }

    fn map<'a>(attributes: &[(&'a str, &'a str)]) -> HashMap<&'a str, &'a str> {
        attributes.iter().copied().collect()
    }

    /// Remove every item with `attributes`, in every keyring.
    fn delete_all(
        service: &SecretService,
        attributes: &[(&str, &str)],
    ) -> Result<(), KeyringError> {
        let found = service.search_items(map(attributes)).map_err(failed)?;
        if !found.locked.is_empty() {
            return Err(KeyringError::Locked);
        }
        for item in &found.unlocked {
            item.delete().map_err(failed)?;
        }
        Ok(())
    }

    impl Keyring for SecretServiceKeyring {
        fn get(&self, attributes: &[(&str, &str)]) -> Result<Option<Vec<u8>>, KeyringError> {
            let service = service()?;
            let found = service.search_items(map(attributes)).map_err(failed)?;
            if !found.locked.is_empty() {
                return Err(KeyringError::Locked);
            }
            match found.unlocked.first() {
                Some(item) => item.get_secret().map(Some).map_err(failed),
                None => Ok(None),
            }
        }

        fn set(
            &self,
            label: &str,
            attributes: &[(&str, &str)],
            secret: &[u8],
        ) -> Result<(), KeyringError> {
            let service = service()?;
            let keyring = service
                .get_default_collection()
                .map_err(|error| match error {
                    Error::NoResult => KeyringError::NoDefault,
                    other => failed(other),
                })?;
            if keyring.is_locked().map_err(failed)? {
                return Err(KeyringError::Locked);
            }
            // One item, wherever earlier ones were kept: a copy left in
            // another keyring could be read back in its place.
            delete_all(&service, attributes)?;
            keyring
                .create_item(
                    label,
                    map(attributes),
                    secret,
                    true,
                    "application/octet-stream",
                )
                .map_err(failed)?;
            Ok(())
        }

        fn delete(&self, attributes: &[(&str, &str)]) -> Result<(), KeyringError> {
            delete_all(&service()?, attributes)
        }
    }
}

/// Against a real Secret Service: CI's Rust job runs it inside its own
/// D-Bus session with GNOME Keyring unlocked (`--ignored`).
#[cfg(all(test, target_os = "linux"))]
mod real_keyring {
    use kriyon_remote_link::keys::SecretVault;

    use super::{KeyringVault, SecretServiceKeyring};

    #[test]
    #[ignore = "needs a Secret Service: CI's keyring step runs it"]
    fn the_real_keyring_keeps_reads_and_drops_a_secret() {
        let vault = KeyringVault::new(SecretServiceKeyring, "com.leafycode.kriyon.ci", "test");
        vault.remove().expect("cleared");
        assert_eq!(vault.read(), Ok(None));
        vault.write(&[3; 32]).expect("kept");
        vault.write(&[4; 32]).expect("replaced");
        assert_eq!(vault.read(), Ok(Some(vec![4; 32])));
        vault.remove().expect("removed");
        assert_eq!(vault.read(), Ok(None));
    }
}
