//! [Attachment]s: files and images the user adds to a composer message.
//!
//! Every path an attachment can name comes from the Rust side — the native
//! file picker, the clipboard, a drop on the window, a pasted image Kriyon
//! saved, or an image Claude Code recorded in the transcript — and is
//! *admitted* here before the frontend ever sees it. The frontend refers back
//! to attachments only by an admitted path: a preview or a send of anything
//! else is refused. How an attachment reaches Claude is
//! `kriyon_core::attachment`.

use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use kriyon_core::attachment::{self, AttachmentKind, Outgoing};
use kriyon_core::session::{SessionEngine as _, SessionId};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

use crate::AppState;

/// The largest file a preview or a pasted image may be.
const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;

/// How much of an image is read to find its size.
const HEADER_BYTES: u64 = 64 * 1024;

/// How long Kriyon keeps an image the user pasted.
const PASTE_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The folder (under the app's data folder) pasted images are saved in.
const PASTE_DIR: &str = "attachments";

/// One admitted attachment, as the composer shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub path: String,
    pub name: String,
    pub kind: AttachmentKind,
    pub bytes: u64,
    /// Why it may not reach Claude as expected (too big, a format Claude can't view).
    pub caution: Option<String>,
    /// The file the user chose, when this is a copy converted so Claude can
    /// see it (a HEIC photo made JPEG).
    pub converted_from: Option<String>,
}

/// Every attachment admitted this run, by path, and the folder converted
/// copies are written to (set once the app knows its data folder).
#[derive(Default)]
pub struct AttachmentRegistry {
    admitted: Mutex<HashMap<String, Attachment>>,
    /// What each path a transcript recorded was admitted as, by that path.
    recorded: Mutex<HashMap<String, Attachment>>,
    convert_dir: Mutex<Option<PathBuf>>,
}

impl AttachmentRegistry {
    /// Where converted copies go. Until set, nothing is converted.
    pub fn set_convert_dir(&self, dir: PathBuf) {
        *self.convert_dir.lock() = Some(dir);
    }

    fn get(&self, path: &str) -> Option<Attachment> {
        self.admitted.lock().get(path).cloned()
    }

    /// Admit `path`: it must exist as a file or folder. Its real path (links
    /// resolved) is what is recorded and sent.
    ///
    /// # Errors
    /// When the path doesn't exist, can't be read, isn't valid text, or has a
    /// control character in it.
    pub fn admit(&self, path: &Path) -> Result<Attachment, String> {
        let real = std::fs::canonicalize(path)
            .map_err(|e| format!("Can't attach {}: {e}", path.display()))?;
        let text = real
            .to_str()
            .ok_or_else(|| "Can't attach a path that isn't valid text".to_string())?
            .to_string();
        if !attachment::is_typeable(&text) {
            return Err(format!(
                "Can't attach {}: its name has a control character",
                path.display()
            ));
        }
        let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
        if meta.is_file() {
            if let Some(converted) = self.convert(&real) {
                return Ok(converted);
            }
        }
        let mut kind = attachment::kind_of(&real, meta.is_dir());
        let mut dims = None;
        if kind == AttachmentKind::Image {
            let head = read_head(&real).unwrap_or_default();
            if attachment::sniff(&head).is_none() {
                // Named like a picture but isn't one: let Claude read it as a file.
                kind = AttachmentKind::File;
            }
            dims = attachment::dimensions(&head);
        }
        let found = Attachment {
            name: real
                .file_name()
                .map_or_else(|| text.clone(), |n| n.to_string_lossy().into_owned()),
            caution: attachment::caution(&real, kind, dims),
            kind,
            bytes: if meta.is_dir() { 0 } else { meta.len() },
            converted_from: None,
            path: text.clone(),
        };
        self.admitted.lock().insert(text, found.clone());
        Ok(found)
    }

    /// A picture Claude can't see, converted to one it can and admitted in
    /// its place; `None` when it needs no conversion or the conversion failed
    /// (it is then attached as a file, with a caution saying so).
    fn convert(&self, real: &Path) -> Option<Attachment> {
        let conversion = attachment::conversion_for(real)?;
        let dir = self.convert_dir.lock().clone()?;
        kriyon_core::private_fs::create_private_dir(&dir).ok()?;
        let stem = real.file_stem()?.to_string_lossy().into_owned();
        let out = unique_path(&dir, &stem, conversion.extension);
        convert_with_sips(real, &out, conversion.format).ok()?;
        let mut copy = self.admit(&out).ok()?;
        copy.converted_from = real.file_name().map(|n| n.to_string_lossy().into_owned());
        self.admitted.lock().insert(copy.path.clone(), copy.clone());
        Some(copy)
    }

    /// Admit a path the transcript recorded. The view reads its turns every
    /// second or so while Claude works; each recorded path is admitted (and
    /// converted, if it must be) once, and reused after that.
    ///
    /// # Errors
    /// As [`Self::admit`].
    pub fn admit_recorded(&self, path: &str) -> Result<Attachment, String> {
        if let Some(found) = self.recorded.lock().get(path) {
            return Ok(found.clone());
        }
        let found = self.admit(Path::new(path))?;
        self.recorded.lock().insert(path.to_string(), found.clone());
        Ok(found)
    }

    /// Admit each of `paths` that can be, skipping the rest.
    pub fn admit_all(&self, paths: &[PathBuf]) -> Vec<Attachment> {
        paths.iter().filter_map(|p| self.admit(p).ok()).collect()
    }
}

fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::new();
    std::fs::File::open(path)?
        .take(HEADER_BYTES)
        .read_to_end(&mut head)?;
    Ok(head)
}

/// Open the native file picker and attach what the user chose.
///
/// # Errors
/// Never in practice: a cancel attaches nothing.
#[tauri::command]
pub async fn pick_attachments(app: tauri::AppHandle) -> Result<Vec<Attachment>, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let picker = app.dialog().file().set_title("Attach files");
    let chosen = tauri::async_runtime::spawn_blocking(move || picker.blocking_pick_files())
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let paths: Vec<PathBuf> = chosen
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect();
    Ok(app.state::<AttachmentRegistry>().admit_all(&paths))
}

/// The files on the clipboard (copied in Finder), attached. Empty when the
/// clipboard holds no files. Read here, never taken from the webview: only
/// what the user really copied is admitted (ADR-0037).
#[allow(clippy::needless_pass_by_value)]
#[must_use]
#[tauri::command]
pub fn clipboard_attachments(registry: tauri::State<'_, AttachmentRegistry>) -> Vec<Attachment> {
    registry.admit_all(&clipboard_files())
}

/// The files on the clipboard: its file list, or failing that the file URL
/// each pasteboard item carries — the way `WebKit` reads them for a paste.
fn clipboard_files() -> Vec<PathBuf> {
    let files = arboard::Clipboard::new()
        .and_then(|mut cb| cb.get().file_list())
        .unwrap_or_default();
    if files.is_empty() {
        file_url_paths(&pasteboard_file_urls())
    } else {
        files
    }
}

/// The `public.file-url` of each item on the general pasteboard.
#[cfg(target_os = "macos")]
fn pasteboard_file_urls() -> Vec<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    let board = NSPasteboard::generalPasteboard();
    let Some(items) = board.pasteboardItems() else {
        return Vec::new();
    };
    items
        .iter()
        // SAFETY: an AppKit constant, valid for the life of the process.
        .filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL }))
        .map(|url| url.to_string())
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn pasteboard_file_urls() -> Vec<String> {
    Vec::new()
}

/// The local paths of the `file://` URLs among `urls`.
fn file_url_paths(urls: &[String]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|u| tauri::Url::parse(u.trim()).ok())
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .collect()
}

/// Save an image the user pasted (raw bytes in the body) and attach it.
///
/// # Errors
/// When the body isn't a PNG, JPEG, GIF or WebP image, is too big, or can't
/// be saved.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn save_pasted_image(
    app: tauri::AppHandle,
    registry: tauri::State<'_, AttachmentRegistry>,
    request: tauri::ipc::Request<'_>,
) -> Result<Attachment, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_pasted_image body must be raw bytes".to_string());
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("That image is too big to attach (over 30 MB).".to_string());
    }
    let format = attachment::sniff(bytes)
        .ok_or_else(|| "Only PNG, JPEG, GIF and WebP images can be pasted.".to_string())?;
    let dir = paste_dir(&app)?;
    kriyon_core::private_fs::create_private_dir(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = unique_path(&dir, &format!("pasted-{stamp}"), format.extension());
    write_private(&path, bytes).map_err(|e| e.to_string())?;
    registry.admit(&path)
}

/// `<dir>/<stem>.<ext>`, or `<stem>-2.<ext>`, `-3`… if that is taken.
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{stem}-{n}.{ext}"));
    }
    path
}

/// Convert `src` to `format` at `out` with macOS's own `sips`, owner-only.
fn convert_with_sips(src: &Path, out: &Path, format: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    let mut command = std::process::Command::new("/usr/bin/sips");
    command.arg("-s").arg("format").arg(format);
    if format == "jpeg" {
        command.args(["-s", "formatOptions", "85"]);
    }
    let done = command
        .arg(src)
        .arg("--out")
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if !done.status.success() || !out.is_file() {
        let _ = std::fs::remove_file(out);
        return Err(String::from_utf8_lossy(&done.stderr).trim().to_string());
    }
    std::fs::set_permissions(out, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

fn paste_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(PASTE_DIR))
}

/// At startup: point conversions at the app's attachments folder, and delete
/// pasted and converted images older than [`PASTE_RETENTION`]. Best-effort.
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Ok(dir) = paste_dir(app) else { return };
    prune_older_than(&dir, PASTE_RETENTION, SystemTime::now());
    app.state::<AttachmentRegistry>().set_convert_dir(dir);
}

fn prune_older_than(dir: &Path, age: Duration, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|d| d > age));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// An admitted image's bytes, for a thumbnail or a full-size view.
///
/// # Errors
/// When `path` wasn't admitted, isn't an image, is too big or can't be read.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn attachment_preview(
    registry: tauri::State<'_, AttachmentRegistry>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let found = registry
        .get(&path)
        .ok_or_else(|| "Not an attachment".to_string())?;
    if found.kind != AttachmentKind::Image {
        return Err("Not an image".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES || attachment::sniff(&bytes).is_none() {
        return Err("Can't preview this image".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Send a message with its attachments to the session's terminal, the way
/// the CLI's own input takes them (see `kriyon_core::attachment`).
///
/// # Errors
/// When an attachment wasn't admitted, the session is unknown, or a write
/// fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn submit_prompt(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    attachments: Vec<String>,
) -> Result<(), String> {
    kriyon_core::daemon::check_session_id(&session_id)?;
    let registry = app.state::<AttachmentRegistry>();
    let admitted = attachments
        .iter()
        .map(|p| {
            registry
                .get(p)
                .ok_or_else(|| format!("{p} isn't an attachment"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let outgoing: Vec<Outgoing<'_>> = admitted
        .iter()
        .map(|a| Outgoing {
            path: &a.path,
            kind: a.kind,
            bytes: a.bytes,
        })
        .collect();
    let keys = attachment::keystrokes(&text, &outgoing);
    let id = SessionId(session_id);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for key in keys {
            {
                let state = handle.state::<AppState>();
                let sessions = state.sessions.lock();
                let session = sessions
                    .get(&id)
                    .ok_or_else(|| "session not found".to_string())?;
                session
                    .engine
                    .write_stdin(key.text.as_bytes())
                    .map_err(|e| e.to_string())?;
            }
            if key.wait_ms > 0 {
                std::thread::sleep(Duration::from_millis(key.wait_ms));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What a drag over the window is doing, for the composer's drop target.
/// Positions are in physical pixels from the window's top-left.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum DragUpdate {
    Over {
        x: f64,
        y: f64,
    },
    Drop {
        x: f64,
        y: f64,
        attachments: Vec<Attachment>,
    },
    Leave,
}

/// Route a drag-and-drop on the main window to the frontend, admitting the
/// dropped paths first.
pub fn on_drag_drop<R: tauri::Runtime>(window: &tauri::Window<R>, event: &tauri::DragDropEvent) {
    let update = match event {
        tauri::DragDropEvent::Enter { position, .. } | tauri::DragDropEvent::Over { position } => {
            DragUpdate::Over {
                x: position.x,
                y: position.y,
            }
        }
        tauri::DragDropEvent::Drop { paths, position } => {
            // Admitting can convert a picture (a few hundred ms each): never
            // on the window's event thread.
            let (paths, x, y) = (paths.clone(), position.x, position.y);
            let window = window.clone();
            std::thread::spawn(move || {
                let attachments = window.state::<AttachmentRegistry>().admit_all(&paths);
                let _ = window.emit("attachment-drag", DragUpdate::Drop { x, y, attachments });
            });
            return;
        }
        _ => DragUpdate::Leave,
    };
    let _ = window.emit("attachment-drag", update);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admitting_records_the_real_path_kind_and_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = dir.path().join("shot.png");
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&9000_u32.to_be_bytes());
        bytes.extend_from_slice(&10_u32.to_be_bytes());
        std::fs::write(&png, &bytes).expect("write");
        let fake = dir.path().join("fake.png");
        std::fs::write(&fake, b"not an image").expect("write");

        let registry = AttachmentRegistry::default();
        let shot = registry.admit(&png).expect("admit");
        assert_eq!(shot.kind, AttachmentKind::Image);
        assert_eq!(shot.name, "shot.png");
        assert!(shot.caution.is_some(), "9000 px wide");
        assert!(registry.get(&shot.path).is_some());

        assert_eq!(
            registry.admit(&fake).expect("admit").kind,
            AttachmentKind::File,
            "a picture's name alone doesn't make it one"
        );
        assert_eq!(
            registry.admit(dir.path()).expect("admit").kind,
            AttachmentKind::Folder
        );
        assert!(registry.admit(&dir.path().join("gone.png")).is_err());
        assert_eq!(registry.admit_all(&[png, dir.path().join("gone")]).len(), 1);
    }

    #[test]
    fn a_path_that_would_be_read_as_keys_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sly = dir.path().join("x\u{1b}[201~\r.png");
        std::fs::write(&sly, b"not an image").expect("write");

        let registry = AttachmentRegistry::default();
        assert!(registry.admit(&sly).is_err());
        assert_eq!(registry.admit_all(&[sly]).len(), 0);
    }

    /// Converting needs macOS's own `sips`.
    #[cfg(target_os = "macos")]
    mod sips {
        use super::*;

        #[test]
        fn a_picture_claude_cant_see_is_admitted_as_a_converted_copy() {
            let dir = tempfile::tempdir().expect("tempdir");
            // A real 4×4 PNG, then a TIFF made from it by sips itself.
            let real_png = dir.path().join("real.png");
            std::fs::write(&real_png, tiny_png()).expect("write");
            let tiff = dir.path().join("Scan 1.tiff");
            convert_with_sips(&real_png, &tiff, "tiff").expect("make a tiff");

            let registry = AttachmentRegistry::default();
            registry.set_convert_dir(dir.path().join("converted"));
            let copy = registry.admit(&tiff).expect("admit");
            assert_eq!(copy.kind, AttachmentKind::Image);
            assert_eq!(copy.name, "Scan 1.png");
            assert_eq!(copy.converted_from.as_deref(), Some("Scan 1.tiff"));
            assert!(registry.get(&copy.path).is_some());
            assert!(attachment::sniff(&std::fs::read(&copy.path).expect("read")).is_some());

            // Without a folder to write to, it is attached as a file and says why.
            let plain = AttachmentRegistry::default().admit(&tiff).expect("admit");
            assert_eq!(plain.kind, AttachmentKind::File);
            assert!(plain.caution.is_some());
        }

        #[test]
        fn a_recorded_picture_is_admitted_once_however_often_it_is_read() {
            let dir = tempfile::tempdir().expect("tempdir");
            let real_png = dir.path().join("real.png");
            std::fs::write(&real_png, tiny_png()).expect("write");
            let tiff = dir.path().join("Scan.tiff");
            convert_with_sips(&real_png, &tiff, "tiff").expect("make a tiff");
            let converted = dir.path().join("converted");

            let registry = AttachmentRegistry::default();
            registry.set_convert_dir(converted.clone());
            let recorded = tiff.to_str().expect("utf-8");
            let first = registry.admit_recorded(recorded).expect("admit");
            let again = registry.admit_recorded(recorded).expect("admit");
            assert_eq!(first, again);
            assert_eq!(
                std::fs::read_dir(&converted).expect("dir").count(),
                1,
                "converted once, not on every read"
            );
        }

        /// A valid 4×4 RGB PNG.
        fn tiny_png() -> Vec<u8> {
            fn chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
                let mut out = u32::try_from(data.len())
                    .expect("len")
                    .to_be_bytes()
                    .to_vec();
                out.extend_from_slice(kind);
                out.extend_from_slice(data);
                let mut crc_input = kind.to_vec();
                crc_input.extend_from_slice(data);
                out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
                out
            }
            let mut raw = Vec::new();
            for _ in 0..4 {
                raw.push(0);
                raw.extend_from_slice(&[200, 80, 40].repeat(4));
            }
            let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
            png.extend(chunk(b"IHDR", &[0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]));
            png.extend(chunk(b"IDAT", &zlib_stored(&raw)));
            png.extend(chunk(b"IEND", &[]));
            png
        }

        fn crc32(bytes: &[u8]) -> u32 {
            let mut crc = 0xffff_ffff_u32;
            for &b in bytes {
                crc ^= u32::from(b);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 {
                        (crc >> 1) ^ 0xedb8_8320
                    } else {
                        crc >> 1
                    };
                }
            }
            !crc
        }

        /// `data` as an uncompressed zlib stream.
        fn zlib_stored(data: &[u8]) -> Vec<u8> {
            let mut out = vec![0x78, 0x01, 1];
            let len = u16::try_from(data.len()).expect("small");
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(data);
            let (mut a, mut b) = (1_u32, 0_u32);
            for &byte in data {
                a = (a + u32::from(byte)) % 65521;
                b = (b + a) % 65521;
            }
            out.extend_from_slice(&((b << 16) | a).to_be_bytes());
            out
        }
    }

    #[test]
    #[ignore = "requires a real system pasteboard; run locally on macOS"]
    fn copied_files_are_read_off_the_pasteboard_item_by_item() {
        let dir = tempfile::tempdir().expect("tempdir");
        let slip = dir.path().join("My slip.pdf");
        std::fs::write(&slip, b"%PDF").expect("write");
        let real = std::fs::canonicalize(&slip).expect("real");
        let mut cb = arboard::Clipboard::new().expect("clipboard");
        cb.set().file_list(&[&slip]).expect("copy");
        assert_eq!(
            file_url_paths(&pasteboard_file_urls()),
            std::slice::from_ref(&real)
        );
        assert_eq!(clipboard_files(), [real]);
    }

    #[test]
    fn only_file_urls_name_paths() {
        let urls = [
            "file:///Users/me/My%20Docs/slip.pdf".to_string(),
            "https://example.com/a.pdf".to_string(),
            "not a url".to_string(),
        ];
        assert_eq!(
            file_url_paths(&urls),
            [PathBuf::from("/Users/me/My Docs/slip.pdf")]
        );
    }

    #[test]
    fn only_old_pastes_are_pruned() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("a.png"), b"x").expect("write");
        let later = SystemTime::now() + Duration::from_secs(40 * 24 * 60 * 60);
        prune_older_than(dir.path(), PASTE_RETENTION, SystemTime::now());
        assert!(dir.path().join("a.png").exists());
        prune_older_than(dir.path(), PASTE_RETENTION, later);
        assert!(!dir.path().join("a.png").exists());
    }
}
