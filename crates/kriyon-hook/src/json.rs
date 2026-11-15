//! JSON as Claude Code sent it, in its key order, and written the way the
//! Python hook wrote it (`json.dumps`): `", "` and `": "` between items,
//! everything outside printable ASCII escaped. The spool's fields that hold
//! JSON text (a tool input, the questions) and their length caps depend on
//! that text, so the Rust hook writes the same.

use std::fmt::Write as _;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// A JSON value with its object keys in the order they came.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<Json>),
    /// Keys in order; a repeated key keeps its first place and last value.
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// The value at `key` of an object, as Python's `dict.get`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Self::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Whether `key` is in an object, as Python's `in`.
    #[must_use]
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(text) => Some(text),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Self::Arr(items) => Some(items),
            _ => None,
        }
    }

    #[must_use]
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Obj(_))
    }

    /// An integer, as Python's `isinstance(n, int)` sees one (not a bool).
    #[must_use]
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Self::Num(n) => n.as_i64(),
            _ => None,
        }
    }

    /// A finite number, as `isinstance(n, (int, float))` with
    /// `math.isfinite`.
    #[must_use]
    pub fn as_finite(&self) -> Option<f64> {
        match self {
            Self::Num(n) => n.as_f64().filter(|f| f.is_finite()),
            _ => None,
        }
    }

    /// Python's truthiness: `None`, `False`, zero and empty values are false.
    #[must_use]
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(b) => *b,
            Self::Num(n) => n.as_f64().is_some_and(|f| f != 0.0),
            Self::Str(s) => !s.is_empty(),
            Self::Arr(items) => !items.is_empty(),
            Self::Obj(items) => !items.is_empty(),
        }
    }

    /// Python's `str()` of the value: text as is, the rest as Python
    /// prints it (`None`, `True`), containers as JSON text.
    #[must_use]
    pub fn py_str(&self) -> String {
        match self {
            Self::Str(text) => text.clone(),
            Self::Null => "None".into(),
            Self::Bool(true) => "True".into(),
            Self::Bool(false) => "False".into(),
            Self::Num(n) => n.to_string(),
            other => py_dumps(other),
        }
    }
}

/// `value` as Python's `json.dumps(value)` writes it.
#[must_use]
pub fn py_dumps(value: &Json) -> String {
    let mut out = String::new();
    dump(value, &mut out);
    out
}

fn dump(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Num(n) => out.push_str(&n.to_string()),
        Json::Str(text) => dump_str(text, out),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                dump(item, out);
            }
            out.push(']');
        }
        Json::Obj(items) => {
            out.push('{');
            for (i, (key, item)) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                dump_str(key, out);
                out.push_str(": ");
                dump(item, out);
            }
            out.push('}');
        }
    }
}

/// A string as `json.dumps` escapes it (`ensure_ascii`): anything outside
/// ' '..='~' escaped, astral characters as surrogate pairs.
fn dump_str(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0_u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
        }
    }
    out.push('"');
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_unit<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }
    fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
        Ok(Json::Bool(b))
    }
    fn visit_i64<E>(self, n: i64) -> Result<Json, E> {
        Ok(Json::Num(n.into()))
    }
    fn visit_u64<E>(self, n: u64) -> Result<Json, E> {
        Ok(Json::Num(n.into()))
    }
    fn visit_f64<E>(self, n: f64) -> Result<Json, E> {
        Ok(serde_json::Number::from_f64(n).map_or(Json::Null, Json::Num))
    }
    fn visit_str<E>(self, s: &str) -> Result<Json, E> {
        Ok(Json::Str(s.to_string()))
    }
    fn visit_string<E>(self, s: String) -> Result<Json, E> {
        Ok(Json::Str(s))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Json::Arr(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut items: Vec<(String, Json)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            match items.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = value,
                None => items.push((key, value)),
            }
        }
        Ok(Json::Obj(items))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Json {
        serde_json::from_str(text).expect("json")
    }

    #[test]
    fn keys_keep_the_order_claude_sent_them_in() {
        let value = parse(r#"{"b":1,"a":{"z":true,"y":null},"c":[1,"x"]}"#);
        assert_eq!(
            py_dumps(&value),
            r#"{"b": 1, "a": {"z": true, "y": null}, "c": [1, "x"]}"#
        );
    }

    #[test]
    fn a_repeated_key_keeps_its_first_place_and_last_value() {
        assert_eq!(
            py_dumps(&parse(r#"{"a":1,"b":2,"a":3}"#)),
            r#"{"a": 3, "b": 2}"#
        );
    }

    #[test]
    fn text_is_escaped_as_python_escapes_it() {
        let value = Json::Str("é\"\\\n\r\t\u{8}\u{c}\u{1}\u{7f} 🙂~".into());
        assert_eq!(
            py_dumps(&value),
            r#""\u00e9\"\\\n\r\t\b\f\u0001\u007f \ud83d\ude42~""#
        );
    }

    #[test]
    fn numbers_and_empties_read_as_python_writes_them() {
        assert_eq!(
            py_dumps(&parse("[1.5, -2, 0, {}, []]")),
            "[1.5, -2, 0, {}, []]"
        );
    }

    #[test]
    fn truthiness_is_pythons() {
        for falsy in ["null", "false", "0", "0.0", r#""""#, "[]", "{}"] {
            assert!(!parse(falsy).truthy(), "{falsy}");
        }
        for truthy in ["true", "1", r#""x""#, "[0]", r#"{"a":0}"#] {
            assert!(parse(truthy).truthy(), "{truthy}");
        }
    }

    #[test]
    fn a_value_reads_as_python_str_of_it() {
        assert_eq!(parse(r#""a b""#).py_str(), "a b");
        assert_eq!(parse("null").py_str(), "None");
        assert_eq!(parse("true").py_str(), "True");
        assert_eq!(parse("7").py_str(), "7");
    }
}
