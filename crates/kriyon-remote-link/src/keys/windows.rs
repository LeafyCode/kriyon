//! Windows' stores for the app's secrets, for remote access on Windows. A
//! secret that fits a credential (2,560 bytes) is a generic credential in
//! the person's Credential Manager, kept on this PC only
//! (`CRED_PERSIST_LOCAL_MACHINE`, never the roaming `ENTERPRISE`). A bigger
//! one (a long relay sign-in) is sealed with DPAPI, the person's own
//! Windows encryption, into a file in the app's local data folder: never a
//! plain file.

use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{GetLastError, LocalFree, ERROR_NOT_FOUND};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use super::{SecretVault, SizedVault};

/// The most a credential holds.
pub const CREDENTIAL_LIMIT: usize = CRED_MAX_CREDENTIAL_BLOB_SIZE as usize;

/// `text` as a NUL-terminated UTF-16 string.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The name each store keeps a secret under: the app's, then the secret's.
fn name_of(identifier: &str, account: &str) -> String {
    format!("{identifier}.remote/{account}")
}

fn failed(what: &str) -> String {
    // SAFETY: reads this thread's last error; no preconditions.
    let code = unsafe { GetLastError() };
    format!("{what} failed (Windows error {code})")
}

/// A secret as a generic credential in Credential Manager.
pub struct Credential {
    target: Vec<u16>,
    user: Vec<u16>,
}

impl Credential {
    /// The secret `account` of the app `identifier`.
    #[must_use]
    pub fn new(identifier: &str, account: &str) -> Self {
        Self {
            target: wide(&name_of(identifier, account)),
            user: wide(account),
        }
    }
}

impl SecretVault for Credential {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` is NUL-terminated; `found` is valid for writes.
        let ok = unsafe { CredReadW(self.target.as_ptr(), CRED_TYPE_GENERIC, 0, &raw mut found) };
        if ok == 0 {
            // SAFETY: as in `failed`.
            if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(failed("reading Credential Manager"));
        }
        // SAFETY: CredReadW succeeded, so `found` points to a credential
        // whose blob holds `CredentialBlobSize` bytes until CredFree.
        let secret = unsafe {
            let credential = &*found;
            let size = usize::try_from(credential.CredentialBlobSize).unwrap_or(0);
            let secret = if credential.CredentialBlob.is_null() || size == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(credential.CredentialBlob, size).to_vec()
            };
            CredFree(found.cast());
            secret
        };
        Ok(Some(secret))
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        if secret.len() > CREDENTIAL_LIMIT {
            return Err(format!(
                "a credential holds at most {CREDENTIAL_LIMIT} bytes, not {}",
                secret.len()
            ));
        }
        // SAFETY: all-zero is a valid CREDENTIALW (null pointers, no flags).
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = self.target.as_ptr().cast_mut();
        credential.UserName = self.user.as_ptr().cast_mut();
        credential.CredentialBlobSize = u32::try_from(secret.len()).map_err(|e| e.to_string())?;
        credential.CredentialBlob = secret.as_ptr().cast_mut();
        // This PC only: never roams with the profile.
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        // SAFETY: `credential` and the buffers it points to live through the
        // call, which only reads them.
        if unsafe { CredWriteW(&raw const credential, 0) } == 0 {
            return Err(failed("writing Credential Manager"));
        }
        Ok(())
    }

    fn remove(&self) -> Result<(), String> {
        // SAFETY: `target` is NUL-terminated.
        if unsafe { CredDeleteW(self.target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            // SAFETY: as in `failed`.
            if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                return Ok(());
            }
            return Err(failed("removing from Credential Manager"));
        }
        Ok(())
    }
}

/// A secret sealed with DPAPI (this Windows account's key) into a file.
pub struct SealedFile {
    path: PathBuf,
    /// Ties the seal to this app and secret: another app's DPAPI call
    /// can't open it without saying the same.
    entropy: Vec<u8>,
}

impl SealedFile {
    /// The secret `account` of the app `identifier`, in folder `dir` (the
    /// app's local data folder).
    #[must_use]
    pub fn new(dir: &Path, identifier: &str, account: &str) -> Self {
        Self {
            path: dir.join(format!("{account}.sealed")),
            entropy: name_of(identifier, account).into_bytes(),
        }
    }
}

/// `data` as DPAPI's blob type, borrowed.
fn blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, String> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|e| e.to_string())?,
        pbData: data.as_ptr().cast_mut(),
    })
}

/// The bytes DPAPI returned in `out`, which is then freed.
fn taken(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let size = usize::try_from(out.cbData).unwrap_or(0);
    // SAFETY: DPAPI gave `out` with `cbData` bytes at `pbData`, freed with
    // LocalFree once copied.
    unsafe {
        let bytes = if out.pbData.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(out.pbData, size).to_vec()
        };
        LocalFree(out.pbData.cast());
        bytes
    }
}

impl SealedFile {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain)?;
        let entropy = blob(&self.entropy)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: the blobs point to live buffers; `out` is valid for writes.
        let ok = unsafe {
            CryptProtectData(
                &raw const input,
                std::ptr::null(),
                &raw const entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &raw mut out,
            )
        };
        if ok == 0 {
            return Err(failed("sealing with DPAPI"));
        }
        Ok(taken(out))
    }

    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(sealed)?;
        let entropy = blob(&self.entropy)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: as in `seal`.
        let ok = unsafe {
            CryptUnprotectData(
                &raw const input,
                std::ptr::null_mut(),
                &raw const entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &raw mut out,
            )
        };
        if ok == 0 {
            return Err(failed("opening a DPAPI seal"));
        }
        Ok(taken(out))
    }
}

impl SecretVault for SealedFile {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(&self.path) {
            Ok(sealed) => self.open(&sealed).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("reading {}: {e}", self.path.display())),
        }
    }

    fn write(&self, secret: &[u8]) -> Result<(), String> {
        let sealed = self.seal(secret)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Whole or not at all: written beside it, then moved over it.
        let next = self.path.with_extension("sealed.new");
        std::fs::write(&next, sealed).map_err(|e| e.to_string())?;
        std::fs::rename(&next, &self.path).map_err(|e| e.to_string())
    }

    fn remove(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// The app `identifier`'s secret `account` on Windows: in Credential
/// Manager while it fits, else DPAPI-sealed in `dir` (the app's local data
/// folder).
#[must_use]
pub fn app_vault(
    identifier: &str,
    account: &str,
    dir: &Path,
) -> SizedVault<Credential, SealedFile> {
    SizedVault {
        small: Credential::new(identifier, account),
        large: SealedFile::new(dir, identifier, account),
        limit: CREDENTIAL_LIMIT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This test run's own app, so runs never meet each other's items.
    fn app() -> String {
        format!("com.leafycode.kriyon.test.{}", std::process::id())
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(app());
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn a_credential_keeps_reads_replaces_and_removes_a_secret() {
        let credential = Credential::new(&app(), "device-key");
        credential.remove().expect("cleared");
        assert_eq!(credential.read(), Ok(None));
        credential.write(&[7; 32]).expect("kept");
        credential.write(&[8; 32]).expect("replaced");
        assert_eq!(credential.read(), Ok(Some(vec![8; 32])));
        credential.remove().expect("removed");
        assert_eq!(credential.read(), Ok(None));
        credential.remove().expect("nothing to remove");
    }

    #[test]
    fn a_credential_refuses_more_than_it_holds() {
        let credential = Credential::new(&app(), "too-big");
        let error = credential
            .write(&vec![1; CREDENTIAL_LIMIT + 1])
            .expect_err("too big");
        assert!(error.contains("2560"), "{error}");
    }

    #[test]
    fn a_sealed_file_is_never_the_plain_secret_and_reads_back() {
        let dir = scratch();
        let sealed = SealedFile::new(&dir, &app(), "relay");
        let secret = b"a relay sign-in, longer than a credential holds".repeat(80);
        sealed.write(&secret).expect("sealed");
        let on_disk = std::fs::read(dir.join("relay.sealed")).expect("file");
        assert!(!on_disk.windows(20).any(|w| secret.starts_with(w)));
        assert_eq!(sealed.read(), Ok(Some(secret)));
        // The same file, read as another app's, opens nothing.
        let other = SealedFile::new(&dir, "com.example.other", "relay");
        assert!(other.read().is_err());
        sealed.remove().expect("removed");
        assert_eq!(sealed.read(), Ok(None));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_app_vault_keeps_a_small_secret_in_credentials_and_a_big_one_sealed() {
        let dir = scratch();
        let vault = app_vault(&app(), "relay-sized", &dir);
        SecretVault::write(&vault, &[3; 64]).expect("small");
        assert_eq!(vault.small.read(), Ok(Some(vec![3; 64])));
        let big = vec![4; CREDENTIAL_LIMIT + 100];
        SecretVault::write(&vault, &big).expect("big");
        assert_eq!(vault.small.read(), Ok(None));
        assert_eq!(SecretVault::read(&vault), Ok(Some(big)));
        SecretVault::remove(&vault).expect("removed");
        assert_eq!(SecretVault::read(&vault), Ok(None));
        let _ = std::fs::remove_dir_all(dir);
    }
}
