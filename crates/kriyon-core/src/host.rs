//! This computer's name, as a paired device shows it.

/// This computer's name, as a paired device shows it: the OS's host name,
/// without a Mac's `.local`, or "Kriyon" when there is none.
#[must_use]
pub fn computer_name() -> String {
    shown_name(&os_name().unwrap_or_default())
}

/// `raw` as a device shows it.
fn shown_name(raw: &str) -> String {
    // As the app always did: every trailing ".local" goes, nothing else.
    let name = raw.trim_end_matches(".local");
    if name.is_empty() {
        "Kriyon".to_string()
    } else {
        name.to_string()
    }
}

/// The OS's host name (`gethostname`).
#[cfg(unix)]
fn os_name() -> Option<String> {
    let mut buf = [0_u8; 256];
    // SAFETY: `buf` is valid for `buf.len()` bytes of writes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

/// The computer's DNS host name (`GetComputerNameExW`), the name Settings
/// shows.
#[cfg(windows)]
fn os_name() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW,
    };
    let mut buf = [0_u16; 256];
    let mut len = u32::try_from(buf.len()).ok()?;
    // SAFETY: `buf` holds `len` UTF-16 units; the call writes at most that
    // many and sets `len` to how many it wrote, without the NUL.
    let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &raw mut len) };
    if ok == 0 {
        return None;
    }
    let len = usize::try_from(len).ok()?.min(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

#[cfg(not(any(unix, windows)))]
fn os_name() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mac_name_loses_its_local_suffix() {
        assert_eq!(shown_name("Studio.local"), "Studio");
        assert_eq!(
            shown_name("Pubudus-MacBook-Pro.local"),
            "Pubudus-MacBook-Pro"
        );
    }

    #[test]
    fn a_plain_name_is_kept_as_it_is() {
        assert_eq!(shown_name("studio-pc"), "studio-pc");
        assert_eq!(shown_name("DESKTOP-4F2K9QZ"), "DESKTOP-4F2K9QZ");
    }

    #[test]
    fn no_name_is_kriyon() {
        assert_eq!(shown_name(""), "Kriyon");
        assert_eq!(shown_name(".local"), "Kriyon");
    }

    #[test]
    fn this_computer_has_a_name() {
        let name = computer_name();
        assert_ne!(name.trim(), "");
        assert!(!name.contains('\0'), "{name:?}");
    }
}
