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

#[cfg(target_os = "macos")]
use kriyon_remote_link::keys::KeyVault;
use kriyon_remote_link::keys::SecretVault;

/// The app's keychain item `account` (macOS); elsewhere, none yet: reads
/// find nothing and writes fail.
#[must_use]
pub fn app_vault(identifier: &str, account: &'static str) -> Box<dyn SecretVault> {
    #[cfg(target_os = "macos")]
    {
        Box::new(Keychain::item(identifier, account))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (identifier, account);
        Box::new(NoVault)
    }
}

/// No keychain on this platform yet.
#[cfg(not(target_os = "macos"))]
struct NoVault;

#[cfg(not(target_os = "macos"))]
impl SecretVault for NoVault {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
    fn write(&self, _secret: &[u8]) -> Result<(), String> {
        Err("no keychain on this platform yet".into())
    }
    fn remove(&self) -> Result<(), String> {
        Ok(())
    }
}

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
