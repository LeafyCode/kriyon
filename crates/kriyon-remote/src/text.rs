//! Text a device writes that the host shows to the person: a device's name, a
//! session's title. It must not be able to pass for more than it is.

use crate::message::RefuseReason;

/// Check `text`: not empty, at most `max_bytes`, and nothing that draws as
/// other text or as nothing: no control characters (line breaks, escapes), no
/// line or paragraph separators, no bidi controls that reorder what follows,
/// and no zero-width characters.
///
/// # Errors
/// [`RefuseReason::OutOfRange`].
pub fn check_shown_text(text: &str, max_bytes: usize) -> Result<(), RefuseReason> {
    let plain = !text.is_empty() && text.len() <= max_bytes && !text.chars().any(hides_or_fakes);
    if plain {
        Ok(())
    } else {
        Err(RefuseReason::OutOfRange)
    }
}

/// Control characters, and the format characters that move, join or hide
/// text (Unicode categories Cc, Zl, Zp, and the bidi and zero-width Cf ones).
fn hides_or_fakes(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'               // soft hyphen
            | '\u{061C}'             // Arabic letter mark
            | '\u{180E}'             // Mongolian vowel separator
            | '\u{200B}'..='\u{200F}' // zero-width space/joiners, LRM, RLM
            | '\u{2028}'..='\u{202E}' // line/paragraph separators, bidi embeddings
            | '\u{2060}'..='\u{206F}' // word joiner, invisible operators, bidi isolates
            | '\u{FEFF}'             // zero-width no-break space
            | '\u{FFF9}'..='\u{FFFB}' // interlinear annotation
        )
}
