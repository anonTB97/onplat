//! Reading an XER's bytes as text — without a decoder crate.
//!
//! P6 on Windows writes its exports in the server's ANSI code page, which
//! in every yard we expect to meet is Windows-1252; a Linux or newer P6
//! writes UTF-8, sometimes with a byte-order mark. `std::str::from_utf8`
//! settles the first question exactly (UTF-8 is self-validating), and the
//! second is a 128-entry table: the WHATWG `windows-1252` index for bytes
//! `0x80..=0xFF`, hand-copied here so the shell's `TextDecoder("windows-1252")`
//! and this function agree byte for byte. Every byte decodes to something —
//! a code page has no invalid bytes — so this path never refuses a file;
//! the run records which branch was taken and who took it.
//!
//! UTF-16 exports exist and would be a fourth branch here (`docs/programme/s13-xer-survival.md`
//! §Needs from the yard); until a real one is seen, the honest answer is to
//! refuse rather than guess, and a UTF-16 body fails at the parser as a file
//! with no `TASK` section.

use std::borrow::Cow;

/// Which branch of [`decode_xer`] read the bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    /// Valid UTF-8, no byte-order mark.
    Utf8,
    /// Valid UTF-8 behind an `EF BB BF` mark, which was stripped.
    Utf8Bom,
    /// Not valid UTF-8; every byte read through the Windows-1252 table.
    Windows1252,
}

impl Encoding {
    /// The name the run and the shell use: `utf-8` or `windows-1252`. The
    /// byte-order mark is a detail of the bytes, not a different encoding,
    /// so both UTF-8 forms carry one label — [`Self::describe`] says more.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Utf8 | Self::Utf8Bom => "utf-8",
            Self::Windows1252 => "windows-1252",
        }
    }

    /// The banner form: `utf-8`, `utf-8 (byte-order mark stripped)`,
    /// `windows-1252`.
    #[must_use]
    pub const fn describe(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf8Bom => "utf-8 (byte-order mark stripped)",
            Self::Windows1252 => "windows-1252",
        }
    }
}

/// Who decoded the bytes when this module did: the server. The browser
/// decodes uploads itself (`shell-web/src/ingest.ts`) and the run says
/// `browser`; the boot loader and the CLI read bytes and say this.
pub const DECODED_BY_SERVER: &str = "server";

/// The UTF-8 byte-order mark.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// The WHATWG `windows-1252` index for bytes `0x80..=0xFF`, in order. The
/// five bytes the code page leaves undefined (`81 8D 8F 90 9D`) map to their
/// C1 control code points, as the browser's decoder maps them — never to
/// U+FFFD, which would make the server and the shell disagree on a file.
const CP1252_HIGH: [char; 128] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
    '\u{00A0}', '\u{00A1}', '\u{00A2}', '\u{00A3}', '\u{00A4}', '\u{00A5}', '\u{00A6}', '\u{00A7}',
    '\u{00A8}', '\u{00A9}', '\u{00AA}', '\u{00AB}', '\u{00AC}', '\u{00AD}', '\u{00AE}', '\u{00AF}',
    '\u{00B0}', '\u{00B1}', '\u{00B2}', '\u{00B3}', '\u{00B4}', '\u{00B5}', '\u{00B6}', '\u{00B7}',
    '\u{00B8}', '\u{00B9}', '\u{00BA}', '\u{00BB}', '\u{00BC}', '\u{00BD}', '\u{00BE}', '\u{00BF}',
    '\u{00C0}', '\u{00C1}', '\u{00C2}', '\u{00C3}', '\u{00C4}', '\u{00C5}', '\u{00C6}', '\u{00C7}',
    '\u{00C8}', '\u{00C9}', '\u{00CA}', '\u{00CB}', '\u{00CC}', '\u{00CD}', '\u{00CE}', '\u{00CF}',
    '\u{00D0}', '\u{00D1}', '\u{00D2}', '\u{00D3}', '\u{00D4}', '\u{00D5}', '\u{00D6}', '\u{00D7}',
    '\u{00D8}', '\u{00D9}', '\u{00DA}', '\u{00DB}', '\u{00DC}', '\u{00DD}', '\u{00DE}', '\u{00DF}',
    '\u{00E0}', '\u{00E1}', '\u{00E2}', '\u{00E3}', '\u{00E4}', '\u{00E5}', '\u{00E6}', '\u{00E7}',
    '\u{00E8}', '\u{00E9}', '\u{00EA}', '\u{00EB}', '\u{00EC}', '\u{00ED}', '\u{00EE}', '\u{00EF}',
    '\u{00F0}', '\u{00F1}', '\u{00F2}', '\u{00F3}', '\u{00F4}', '\u{00F5}', '\u{00F6}', '\u{00F7}',
    '\u{00F8}', '\u{00F9}', '\u{00FA}', '\u{00FB}', '\u{00FC}', '\u{00FD}', '\u{00FE}', '\u{00FF}',
];

/// One byte through the Windows-1252 table. ASCII is itself; everything
/// above is the table entry.
fn cp1252(byte: u8) -> char {
    match byte.checked_sub(0x80) {
        None => char::from(byte),
        Some(high) => CP1252_HIGH
            .get(usize::from(high))
            .copied()
            // Unreachable — `high` is at most 127 — but a table lookup gets
            // a fallback rather than a panic path in a decoder.
            .unwrap_or(char::REPLACEMENT_CHARACTER),
    }
}

/// Reads an export's bytes as text. Valid UTF-8 is borrowed as it is (a
/// leading byte-order mark is stripped and reported); anything else is read
/// as Windows-1252, which every byte sequence is.
#[must_use]
pub fn decode_xer(bytes: &[u8]) -> (Cow<'_, str>, Encoding) {
    let (body, bom) = match bytes.strip_prefix(BOM) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    match std::str::from_utf8(body) {
        Ok(text) => (
            Cow::Borrowed(text),
            if bom {
                Encoding::Utf8Bom
            } else {
                Encoding::Utf8
            },
        ),
        Err(_) => (
            Cow::Owned(bytes.iter().copied().map(cp1252).collect()),
            Encoding::Windows1252,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The literal that pins both decoders — this one and the shell's
    /// (`scheduleDoor.test.ts` carries the same bytes and the same answer).
    const SHARED_BYTES: &[u8] = &[0x93, 0x94, 0xE9, 0x96, 0x80];
    const SHARED_TEXT: &str = "\u{201C}\u{201D}\u{E9}\u{2013}\u{20AC}";

    #[test]
    fn utf8_passes_through_borrowed_and_a_bom_is_stripped() {
        let plain = "%T\tTASK\n%R\tCaf\u{E9}\n".as_bytes();
        let (text, encoding) = decode_xer(plain);
        assert!(matches!(text, Cow::Borrowed(_)), "no copy for clean UTF-8");
        assert_eq!(text, "%T\tTASK\n%R\tCaf\u{E9}\n");
        assert_eq!(encoding, Encoding::Utf8);
        assert_eq!(encoding.label(), "utf-8");

        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(plain);
        let (text, encoding) = decode_xer(&with_bom);
        assert!(matches!(text, Cow::Borrowed(_)));
        assert!(text.starts_with("%T"), "the mark is gone: {text:?}");
        assert_eq!(encoding, Encoding::Utf8Bom);
        assert_eq!(encoding.label(), "utf-8");
        assert_eq!(encoding.describe(), "utf-8 (byte-order mark stripped)");
    }

    #[test]
    fn windows_1252_quotes_dashes_accents_and_the_euro_decode() {
        let (text, encoding) = decode_xer(SHARED_BYTES);
        assert_eq!(text, SHARED_TEXT);
        assert_eq!(encoding, Encoding::Windows1252);
        assert_eq!(encoding.label(), "windows-1252");
        // A whole line: ASCII is untouched around the high bytes.
        let mut line = b"%R\tA1\tCaf".to_vec();
        line.push(0xE9);
        line.extend_from_slice(b" \x96 prep\n");
        let (text, _) = decode_xer(&line);
        assert_eq!(text, "%R\tA1\tCaf\u{E9} \u{2013} prep\n");
    }

    #[test]
    fn the_five_undefined_bytes_keep_their_code_points() {
        let (text, encoding) = decode_xer(&[0x81, 0x8D, 0x8F, 0x90, 0x9D, 0xFF]);
        assert_eq!(encoding, Encoding::Windows1252);
        assert_eq!(text, "\u{81}\u{8D}\u{8F}\u{90}\u{9D}\u{FF}");
        assert!(!text.contains(char::REPLACEMENT_CHARACTER));
    }

    #[test]
    fn the_table_covers_every_high_byte_exactly_once() {
        // 128 entries, each above U+007F, so no high byte can collapse onto
        // ASCII and change the tab-delimited structure of a line.
        assert!(CP1252_HIGH.iter().all(|c| u32::from(*c) >= 0x80));
        let all: Vec<u8> = (0x80..=0xFF).collect();
        let (text, _) = decode_xer(&all);
        assert_eq!(text.chars().count(), 128);
        assert!(!text.contains('\t') && !text.contains('\n'));
    }
}
