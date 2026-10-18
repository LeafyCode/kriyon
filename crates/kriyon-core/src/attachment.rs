//! An [Attachment]: a file or image the user adds to a composer message, and
//! how it reaches Claude Code — the same way the CLI's own input takes one.
//!
//! - An **image** goes in as a bracketed paste of its path, which is what a
//!   terminal sends when a file is dropped on it; Claude Code turns that into
//!   `[Image #N]` and attaches the picture.
//! - Any **other file or folder** goes in as an `@` mention, which Claude
//!   Code reads into the prompt itself.
//!
//! Everything here is pure: what kind a path is, what an image's header says
//! about its size, and the keystrokes a message with attachments becomes.

use std::path::Path;

use serde::Serialize;

/// The image types Claude can see. Anything else is sent as a plain file.
const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Image types people attach that Claude can't see: photos (converted to
/// JPEG) and graphics (converted to PNG). The API takes only PNG, JPEG, GIF
/// and WebP, and the CLI attaches nothing else as a picture.
const PHOTO_FORMATS: [&str; 3] = ["heic", "heif", "avif"];
const GRAPHIC_FORMATS: [&str; 4] = ["tiff", "tif", "bmp", "svg"];

/// How a picture Claude can't see is turned into one it can: the `sips`
/// format name, and the extension the copy gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conversion {
    pub format: &'static str,
    pub extension: &'static str,
}

/// The conversion `path` needs before Claude can see it, or `None` for a
/// picture it already can (or anything that isn't a picture).
#[must_use]
pub fn conversion_for(path: &Path) -> Option<Conversion> {
    let ext = extension(path);
    if PHOTO_FORMATS.contains(&ext.as_str()) {
        Some(Conversion {
            format: "jpeg",
            extension: "jpg",
        })
    } else if GRAPHIC_FORMATS.contains(&ext.as_str()) {
        Some(Conversion {
            format: "png",
            extension: "png",
        })
    } else {
        None
    }
}

/// The widest or tallest image the API takes.
pub const MAX_IMAGE_SIDE: u32 = 8000;

/// Bracketed paste: what a terminal wraps pasted (or dropped) text in.
const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// How long Claude Code is given to read one pasted image before the next
/// keystroke: a small image takes under 100 ms, an 8 MB one about 400 ms.
const IMAGE_READ_MS: u64 = 250;
const IMAGE_READ_MS_PER_MB: u64 = 60;
const IMAGE_READ_MS_MAX: u64 = 2500;

/// The beat between a message and its submitting Enter. Sent in one burst,
/// the TUI reads the Enter as part of a paste and inserts a newline.
pub const SUBMIT_DELAY_MS: u64 = 80;

/// What an attachment is, which decides how it is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    /// A picture Claude can see.
    Image,
    /// Any other file, read by Claude Code through an `@` mention.
    File,
    /// A folder, mentioned the same way (Claude Code lists it).
    Folder,
}

/// The kind of the attachment at `path`.
#[must_use]
pub fn kind_of(path: &Path, is_dir: bool) -> AttachmentKind {
    if is_dir {
        return AttachmentKind::Folder;
    }
    if IMAGE_EXTENSIONS.contains(&extension(path).as_str()) {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

/// The picture formats this module can read a header of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    /// The file extension a saved paste of this format gets.
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }

    /// The media type a preview of this format is served as.
    #[must_use]
    pub fn media_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
}

/// The format `bytes` start with, by their magic number — never the name.
#[must_use]
pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageFormat::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else {
        None
    }
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

fn le16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn le24(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        0,
    ]))
}

/// Width and height from an image's header, or `None` when the header isn't
/// one this reads (a truncated file, an unusual JPEG). Reads only the first
/// bytes, so a caller can pass a prefix of the file.
#[must_use]
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match sniff(bytes)? {
        ImageFormat::Png => Some((be32(bytes, 16)?, be32(bytes, 20)?)),
        ImageFormat::Gif => Some((le16(bytes, 6)?, le16(bytes, 8)?)),
        ImageFormat::Webp => webp_dimensions(bytes),
        ImageFormat::Jpeg => jpeg_dimensions(bytes),
    }
}

fn webp_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    match b.get(12..16)? {
        b"VP8X" => Some((le24(b, 24)? + 1, le24(b, 27)? + 1)),
        b"VP8L" => {
            let bits = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " => Some((le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff)),
        _ => None,
    }
}

fn jpeg_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    loop {
        while *b.get(at)? == 0xff && *b.get(at + 1)? == 0xff {
            at += 1;
        }
        if *b.get(at)? != 0xff {
            return None;
        }
        let marker = *b.get(at + 1)?;
        // Start-of-frame markers, minus DHT/JPG/DAC, which share the range.
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            return Some((be16(b, at + 7)?, be16(b, at + 5)?));
        }
        let len = usize::try_from(be16(b, at + 2)?).ok()?;
        at += 2 + len;
    }
}

/// Why an attachment may not reach Claude as the user expects, in plain
/// words for its chip; `None` when it's fine.
#[must_use]
pub fn caution(path: &Path, kind: AttachmentKind, dims: Option<(u32, u32)>) -> Option<String> {
    let ext = extension(path);
    if kind == AttachmentKind::File && conversion_for(path).is_some() {
        return Some(format!(
            "Claude can't view .{ext} images, and this one couldn't be converted. Convert it to PNG or JPEG to show it."
        ));
    }
    let (w, h) = dims?;
    (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE).then(|| {
        format!(
            "{w}×{h} px is over the {MAX_IMAGE_SIDE} px limit. Claude may refuse it, so resize it first."
        )
    })
}

/// Whether `path` can be typed into the terminal as an attachment. A control
/// character (ESC, CR, LF…) in a file name would be read as a key, ending a
/// bracketed paste or sending the message early, so such a path is refused.
#[must_use]
pub fn is_typeable(path: &str) -> bool {
    !path.chars().any(char::is_control)
}

/// A path as a terminal types it when the file is dropped on it: every
/// character a shell would read specially behind a backslash.
#[must_use]
pub fn shell_escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if !(c.is_alphanumeric() || "/._-+,:@%=~".contains(c)) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// An `@` mention of `path` that Claude Code reads whole: quoted when the
/// path has a space or a quote in it.
#[must_use]
pub fn mention(path: &str) -> String {
    if path
        .chars()
        .any(|c| c.is_whitespace() || c == '"' || c == '\'')
    {
        format!("@\"{}\"", path.replace('"', "\\\""))
    } else {
        format!("@{path}")
    }
}

/// One attachment as it is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing<'a> {
    pub path: &'a str,
    pub kind: AttachmentKind,
    pub bytes: u64,
}

/// One write to the session's terminal and how long to wait after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keystroke {
    pub text: String,
    pub wait_ms: u64,
}

fn image_read_ms(bytes: u64) -> u64 {
    (IMAGE_READ_MS + IMAGE_READ_MS_PER_MB * (bytes / 1_000_000)).min(IMAGE_READ_MS_MAX)
}

/// The keystrokes that send `text` with `attachments`, ending with Enter:
/// the text with each file's `@` mention after it, then each image as a
/// pasted path, each given time to be read before anything follows.
#[must_use]
pub fn keystrokes(text: &str, attachments: &[Outgoing<'_>]) -> Vec<Keystroke> {
    let mut first = text.trim().to_string();
    for file in attachments
        .iter()
        .filter(|a| a.kind != AttachmentKind::Image)
    {
        if !first.is_empty() {
            first.push(' ');
        }
        first.push_str(&mention(file.path));
    }
    let images: Vec<&Outgoing<'_>> = attachments
        .iter()
        .filter(|a| a.kind == AttachmentKind::Image)
        .collect();
    // A trailing space ends a mention, so the Enter can't pick an `@`
    // completion instead of sending, and keeps a pasted image off the text.
    if !attachments.is_empty() {
        first.push(' ');
    }
    let mut out = Vec::new();
    if !first.trim().is_empty() {
        out.push(Keystroke {
            text: first,
            wait_ms: SUBMIT_DELAY_MS,
        });
    }
    for image in images {
        out.push(Keystroke {
            text: format!("{PASTE_START}{}{PASTE_END}", shell_escape(image.path)),
            wait_ms: image_read_ms(image.bytes),
        });
    }
    if !out.is_empty() {
        out.push(Keystroke {
            text: "\r".to_string(),
            wait_ms: 0,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b
    }

    #[test]
    fn kinds_come_from_the_extension_and_folders_from_the_flag() {
        assert_eq!(
            kind_of(Path::new("/a/Shot.PNG"), false),
            AttachmentKind::Image
        );
        assert_eq!(
            kind_of(Path::new("/a/p.webp"), false),
            AttachmentKind::Image
        );
        assert_eq!(
            kind_of(Path::new("/a/notes.md"), false),
            AttachmentKind::File
        );
        assert_eq!(
            kind_of(Path::new("/a/photo.heic"), false),
            AttachmentKind::File
        );
        assert_eq!(kind_of(Path::new("/a/src"), true), AttachmentKind::Folder);
    }

    #[test]
    fn pictures_claude_cant_see_are_converted_to_one_it_can() {
        assert_eq!(
            conversion_for(Path::new("/a/IMG_1.HEIC")),
            Some(Conversion {
                format: "jpeg",
                extension: "jpg"
            })
        );
        assert_eq!(
            conversion_for(Path::new("/a/scan.tiff")),
            Some(Conversion {
                format: "png",
                extension: "png"
            })
        );
        assert_eq!(conversion_for(Path::new("/a/shot.png")), None);
        assert_eq!(conversion_for(Path::new("/a/notes.md")), None);
    }

    #[test]
    fn formats_are_sniffed_from_bytes() {
        assert_eq!(sniff(&png_header(1, 1)), Some(ImageFormat::Png));
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some(ImageFormat::Jpeg));
        assert_eq!(sniff(b"GIF89a.."), Some(ImageFormat::Gif));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8X"), Some(ImageFormat::Webp));
        assert_eq!(sniff(b"<svg"), None);
    }

    #[test]
    fn dimensions_are_read_from_each_header() {
        assert_eq!(dimensions(&png_header(1920, 1080)), Some((1920, 1080)));
        assert_eq!(dimensions(b"GIF89a\x40\x01\xf0\x00"), Some((320, 240)));
        // JPEG: SOI, an APP0 segment, then SOF0 with height 600, width 800.
        let jpeg = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02,
            0x58, 0x03, 0x20,
        ];
        assert_eq!(dimensions(&jpeg), Some((800, 600)));
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        vp8x.extend_from_slice(&[0; 8]);
        vp8x.extend_from_slice(&[0x1f, 0x03, 0x00, 0x57, 0x02, 0x00]);
        assert_eq!(dimensions(&vp8x), Some((800, 600)));
        assert_eq!(dimensions(&png_header(1, 1)[..12]), None, "truncated");
    }

    #[test]
    fn a_caution_names_what_will_go_wrong() {
        let big = caution(
            Path::new("/a.png"),
            AttachmentKind::Image,
            Some((9000, 100)),
        );
        assert!(big.is_some_and(|c| c.contains("9000×100")));
        assert_eq!(
            caution(
                Path::new("/a.png"),
                AttachmentKind::Image,
                Some((4000, 3000))
            ),
            None
        );
        let heic = caution(Path::new("/IMG_1.HEIC"), AttachmentKind::File, None);
        assert!(heic.is_some_and(|c| c.contains(".heic")));
        assert_eq!(
            caution(Path::new("/a.rs"), AttachmentKind::File, None),
            None
        );
    }

    #[test]
    fn paths_are_escaped_the_way_a_terminal_drop_types_them() {
        assert_eq!(
            shell_escape("/tmp/a b/it's (1).png"),
            r"/tmp/a\ b/it\'s\ \(1\).png"
        );
        assert_eq!(shell_escape("/Users/me/x-1_2.png"), "/Users/me/x-1_2.png");
    }

    #[test]
    fn a_path_with_a_control_character_cant_be_typed() {
        assert!(is_typeable("/tmp/a b/it's (1).png"));
        assert!(!is_typeable("/tmp/x\u{1b}[201~\r.png"));
        assert!(!is_typeable("/tmp/line\nbreak.txt"));
    }

    #[test]
    fn a_mention_is_quoted_only_when_it_must_be() {
        assert_eq!(mention("/src/main.rs"), "@/src/main.rs");
        assert_eq!(mention("/my notes/a.txt"), "@\"/my notes/a.txt\"");
    }

    #[test]
    fn a_message_becomes_text_and_mentions_then_pasted_images_then_enter() {
        let attachments = [
            Outgoing {
                path: "/shots/a b.png",
                kind: AttachmentKind::Image,
                bytes: 8_000_000,
            },
            Outgoing {
                path: "/notes/todo.md",
                kind: AttachmentKind::File,
                bytes: 10,
            },
        ];
        let keys = keystrokes("  look at these ", &attachments);
        assert_eq!(
            keys,
            vec![
                Keystroke {
                    text: "look at these @/notes/todo.md ".into(),
                    wait_ms: SUBMIT_DELAY_MS
                },
                Keystroke {
                    text: "\x1b[200~/shots/a\\ b.png\x1b[201~".into(),
                    wait_ms: 250 + 60 * 8
                },
                Keystroke {
                    text: "\r".into(),
                    wait_ms: 0
                },
            ]
        );
    }

    #[test]
    fn plain_text_is_sent_as_before_and_nothing_sends_nothing() {
        assert_eq!(
            keystrokes("hi", &[]),
            vec![
                Keystroke {
                    text: "hi".into(),
                    wait_ms: SUBMIT_DELAY_MS
                },
                Keystroke {
                    text: "\r".into(),
                    wait_ms: 0
                },
            ]
        );
        assert_eq!(keystrokes("   ", &[]), Vec::<Keystroke>::new());
    }

    #[test]
    fn an_image_alone_is_sent_without_text() {
        let keys = keystrokes(
            "",
            &[Outgoing {
                path: "/a.png",
                kind: AttachmentKind::Image,
                bytes: 0,
            }],
        );
        assert_eq!(keys.len(), 2);
        assert!(keys[0].text.starts_with("\x1b[200~"));
        assert_eq!(image_read_ms(1_000_000_000), IMAGE_READ_MS_MAX);
    }
}
