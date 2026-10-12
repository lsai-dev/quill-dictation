//! Line-delimited JSON framing shared by the Quill sidecars.
//!
//! This file is compiled into both binaries (`#[path]`-included as `mod protocol`).
//!
//! # Wire format
//!
//! * **Requests** arrive on stdin as one UTF-8 JSON object per line, terminated by `\n`
//!   (a trailing `\r` is tolerated). If the object has `"bytes": N`, exactly `N` raw bytes
//!   follow immediately after the newline; they are always consumed, even when the request
//!   is rejected, so the stream never loses sync.
//! * **Responses** go to stdout as one JSON object per line:
//!   `{"id":<echoed>,"ok":true,...}` or `{"id":<echoed or null>,"ok":false,"error":"..."}`.
//! * **Events** are unsolicited lines with an `"event"` field and no `"id"`.
//!
//! stdout carries protocol lines only; diagnostics go to stderr via [`log!`].

// Each binary uses a different subset of this module.
#![allow(dead_code)]

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::io::{self, BufRead, Read, Write};
use std::sync::{Arc, Mutex};

/// Longest request line we are willing to buffer. Longer lines are skipped and rejected.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Binary data attached to a request via its `"bytes"` field.
#[derive(Debug, PartialEq, Eq)]
pub enum Payload {
    /// The request had no `"bytes"` field.
    None,
    /// The payload, read in full.
    Data(Vec<u8>),
    /// The payload exceeded the caller's limit; this many bytes were read and discarded.
    Discarded(u64),
}

/// A well-formed request.
#[derive(Debug)]
pub struct Request {
    /// The request's `"id"`, echoed back verbatim (`null` when absent).
    pub id: Value,
    pub cmd: String,
    /// The whole request object; typed arguments are extracted with [`Request::args`].
    pub body: Value,
    pub payload: Payload,
}

impl Request {
    /// Deserializes the request object into a typed argument struct.
    ///
    /// Unknown fields (including `id`, `cmd` and `bytes`) are ignored unless the target
    /// type opts into `deny_unknown_fields`.
    pub fn args<T: DeserializeOwned>(&self) -> Result<T, String> {
        T::deserialize(&self.body).map_err(|e| format!("invalid arguments for '{}': {e}", self.cmd))
    }
}

/// One unit read from the input stream.
#[derive(Debug)]
pub enum Frame {
    Request(Request),
    /// A line that could not be turned into a request. Reply with `ok:false` and carry on.
    Invalid { id: Value, error: String },
}

/// Reads the next frame from `reader`.
///
/// Returns `Ok(None)` on end of input (including EOF in the middle of a binary payload).
/// Payloads larger than `max_payload` bytes are consumed and discarded
/// ([`Payload::Discarded`]) instead of being buffered.
pub fn read_frame<R: BufRead>(reader: &mut R, max_payload: u64) -> io::Result<Option<Frame>> {
    loop {
        let line = match read_line_limited(reader, MAX_LINE_BYTES)? {
            Line::Eof => return Ok(None),
            Line::TooLong => {
                return Ok(Some(Frame::Invalid {
                    id: Value::Null,
                    error: format!("request line exceeds {MAX_LINE_BYTES} bytes"),
                }))
            }
            Line::Data(line) => line,
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue; // tolerate blank lines
        }
        return parse_line(reader, &line, max_payload);
    }
}

fn parse_line<R: BufRead>(reader: &mut R, line: &[u8], max_payload: u64) -> io::Result<Option<Frame>> {
    let body: Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(e) => {
            return Ok(Some(Frame::Invalid { id: Value::Null, error: format!("malformed JSON: {e}") }))
        }
    };
    let Some(obj) = body.as_object() else {
        return Ok(Some(Frame::Invalid { id: Value::Null, error: "request must be a JSON object".into() }));
    };
    let id = obj.get("id").cloned().unwrap_or(Value::Null);

    // The payload must be consumed before anything else can be rejected.
    let payload = match obj.get("bytes") {
        None | Some(Value::Null) => Payload::None,
        Some(v) => match v.as_u64() {
            Some(n) => match read_payload(reader, n, max_payload)? {
                Some(p) => p,
                None => return Ok(None), // EOF inside the payload
            },
            None => {
                return Ok(Some(Frame::Invalid {
                    id,
                    error: "'bytes' must be a non-negative integer".into(),
                }))
            }
        },
    };

    let cmd = match obj.get("cmd") {
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Ok(Some(Frame::Invalid { id, error: "'cmd' must be a string".into() })),
        None => return Ok(Some(Frame::Invalid { id, error: "missing 'cmd'".into() })),
    };
    Ok(Some(Frame::Request(Request { id, cmd, body, payload })))
}

/// Reads exactly `len` bytes. Returns `None` if the stream ends first.
fn read_payload<R: Read>(reader: &mut R, len: u64, max: u64) -> io::Result<Option<Payload>> {
    if len > max {
        let copied = io::copy(&mut reader.by_ref().take(len), &mut io::sink())?;
        return Ok((copied == len).then_some(Payload::Discarded(len)));
    }
    let len = usize::try_from(len).map_err(|_| io::Error::other("payload length overflows usize"))?;
    let mut buf = vec![0u8; len];
    match reader.read_exact(&mut buf) {
        Ok(()) => Ok(Some(Payload::Data(buf))),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

enum Line {
    Eof,
    TooLong,
    Data(Vec<u8>),
}

/// Reads one `\n`-terminated line (without the terminator or a trailing `\r`), never
/// buffering more than `max` bytes. An unterminated final line is returned as a line.
fn read_line_limited<R: BufRead>(reader: &mut R, max: usize) -> io::Result<Line> {
    let mut line = Vec::new();
    let mut too_long = false;
    let mut saw_any = false;
    loop {
        let buf = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if buf.is_empty() {
            if !saw_any {
                return Ok(Line::Eof);
            }
            break;
        }
        saw_any = true;
        let newline = buf.iter().position(|&b| b == b'\n');
        let chunk = &buf[..newline.unwrap_or(buf.len())];
        if !too_long {
            if line.len() + chunk.len() > max {
                too_long = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(chunk);
            }
        }
        let used = chunk.len() + usize::from(newline.is_some());
        reader.consume(used);
        if newline.is_some() {
            break;
        }
    }
    if too_long {
        return Ok(Line::TooLong);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Line::Data(line))
}

/// An empty set of reply fields: `out.reply_ok(&id, Empty {})` sends `{"id":..,"ok":true}`.
#[derive(Serialize)]
pub struct Empty {}

#[derive(Serialize)]
struct OkReply<'a, T> {
    id: &'a Value,
    ok: bool,
    #[serde(flatten)]
    data: T,
}

#[derive(Serialize)]
struct ErrReply<'a> {
    id: &'a Value,
    ok: bool,
    error: &'a str,
}

#[derive(Serialize)]
struct EventLine<'a, T> {
    event: &'a str,
    #[serde(flatten)]
    data: T,
}

/// Thread-safe writer for protocol lines. Every line is written whole and flushed.
#[derive(Clone)]
pub struct Output {
    sink: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Output {
    pub fn new<W: Write + Send + 'static>(writer: W) -> Self {
        Output { sink: Arc::new(Mutex::new(Box::new(writer))) }
    }

    /// Serializes `msg` as a single line. An error means the reader has gone away.
    pub fn send<T: Serialize>(&self, msg: &T) -> io::Result<()> {
        let mut line = serde_json::to_vec(msg).map_err(io::Error::other)?;
        line.push(b'\n');
        // A poisoned lock only means another thread panicked mid-write; keep going.
        let mut sink = self.sink.lock().unwrap_or_else(|p| p.into_inner());
        sink.write_all(&line)?;
        sink.flush()
    }

    /// `{"id":..,"ok":true, ...data}`. `data` must serialize to a JSON object.
    pub fn reply_ok<T: Serialize>(&self, id: &Value, data: T) -> io::Result<()> {
        self.send(&OkReply { id, ok: true, data })
    }

    /// `{"id":..,"ok":false,"error":..}`.
    pub fn reply_err(&self, id: &Value, error: &str) -> io::Result<()> {
        self.send(&ErrReply { id, ok: false, error })
    }

    /// `{"event":name, ...data}`. `data` must serialize to a JSON object.
    pub fn event<T: Serialize>(&self, name: &str, data: T) -> io::Result<()> {
        self.send(&EventLine { event: name, data })
    }
}

/// Writes one diagnostic line to stderr, prefixed with the binary's name.
pub fn log_line(args: fmt::Arguments) {
    let mut err = io::stderr().lock();
    let _ = writeln!(err, "[{}] {}", env!("CARGO_PKG_NAME"), args);
}

/// `log!("...")`: diagnostics to stderr (never stdout).
macro_rules! log {
    ($($arg:tt)*) => { $crate::protocol::log_line(format_args!($($arg)*)) };
}
pub(crate) use log;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frames(input: &[u8], max_payload: u64) -> Vec<Frame> {
        let mut cur = Cursor::new(input.to_vec());
        let mut out = Vec::new();
        while let Some(f) = read_frame(&mut cur, max_payload).expect("io error") {
            out.push(f);
        }
        out
    }

    fn req(f: &Frame) -> &Request {
        match f {
            Frame::Request(r) => r,
            Frame::Invalid { error, .. } => panic!("expected request, got error: {error}"),
        }
    }

    #[test]
    fn parses_simple_requests_and_skips_blank_lines() {
        let fs = frames(b"{\"id\":1,\"cmd\":\"info\"}\n\n  \r\n{\"id\":\"x\",\"cmd\":\"shutdown\"}\r\n", 0);
        assert_eq!(fs.len(), 2);
        assert_eq!(req(&fs[0]).cmd, "info");
        assert_eq!(req(&fs[0]).id, Value::from(1));
        assert_eq!(req(&fs[0]).payload, Payload::None);
        assert_eq!(req(&fs[1]).id, Value::from("x"));
    }

    #[test]
    fn reads_binary_payload_and_stays_in_sync() {
        let mut input = b"{\"id\":2,\"cmd\":\"transcribe\",\"bytes\":5}\n".to_vec();
        input.extend_from_slice(b"ab\ncd"); // payload may contain newlines
        input.extend_from_slice(b"{\"id\":3,\"cmd\":\"info\"}\n");
        let fs = frames(&input, 100);
        assert_eq!(fs.len(), 2);
        assert_eq!(req(&fs[0]).payload, Payload::Data(b"ab\ncd".to_vec()));
        assert_eq!(req(&fs[1]).cmd, "info");
    }

    #[test]
    fn oversized_payload_is_discarded_but_consumed() {
        let mut input = b"{\"id\":2,\"cmd\":\"transcribe\",\"bytes\":8}\n".to_vec();
        input.extend_from_slice(&[0u8; 8]);
        input.extend_from_slice(b"{\"id\":3,\"cmd\":\"info\"}\n");
        let fs = frames(&input, 4);
        assert_eq!(req(&fs[0]).payload, Payload::Discarded(8));
        assert_eq!(req(&fs[1]).id, Value::from(3));
    }

    #[test]
    fn zero_length_payload() {
        let fs = frames(b"{\"cmd\":\"transcribe\",\"bytes\":0}\n{\"cmd\":\"info\"}\n", 10);
        assert_eq!(req(&fs[0]).payload, Payload::Data(Vec::new()));
        assert_eq!(req(&fs[0]).id, Value::Null);
        assert_eq!(req(&fs[1]).cmd, "info");
    }

    #[test]
    fn payload_is_consumed_even_without_cmd() {
        let mut input = b"{\"id\":7,\"bytes\":3}\n".to_vec();
        input.extend_from_slice(b"xyz{\"id\":8,\"cmd\":\"info\"}\n");
        let fs = frames(&input, 10);
        match &fs[0] {
            Frame::Invalid { id, error } => {
                assert_eq!(*id, Value::from(7));
                assert!(error.contains("cmd"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(req(&fs[1]).id, Value::from(8));
    }

    #[test]
    fn truncated_payload_is_eof() {
        let fs = frames(b"{\"id\":1,\"cmd\":\"transcribe\",\"bytes\":10}\nabc", 100);
        assert!(fs.is_empty());
    }

    #[test]
    fn malformed_json_and_non_objects_are_invalid() {
        let fs = frames(b"{nope\n[1,2]\n{\"id\":4,\"cmd\":5}\n{\"id\":5,\"cmd\":\"x\",\"bytes\":-1}\n", 0);
        assert_eq!(fs.len(), 4);
        for f in &fs[..2] {
            assert!(matches!(f, Frame::Invalid { id: Value::Null, .. }), "{f:?}");
        }
        assert!(matches!(&fs[2], Frame::Invalid { id, .. } if *id == 4));
        assert!(matches!(&fs[3], Frame::Invalid { error, .. } if error.contains("bytes")));
    }

    #[test]
    fn unterminated_last_line_is_processed() {
        let fs = frames(b"{\"id\":1,\"cmd\":\"shutdown\"}", 0);
        assert_eq!(req(&fs[0]).cmd, "shutdown");
    }

    #[test]
    fn overlong_line_is_rejected_and_skipped() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 10];
        input.extend_from_slice(b"\n{\"id\":1,\"cmd\":\"info\"}\n");
        let fs = frames(&input, 0);
        assert!(matches!(&fs[0], Frame::Invalid { error, .. } if error.contains("exceeds")));
        assert_eq!(req(&fs[1]).cmd, "info");
    }

    #[test]
    fn typed_args() {
        #[derive(serde::Deserialize)]
        struct A {
            enabled: bool,
            #[serde(default)]
            n: u32,
        }
        let fs = frames(b"{\"id\":1,\"cmd\":\"x\",\"enabled\":true}\n{\"id\":2,\"cmd\":\"x\"}\n", 0);
        let a: A = req(&fs[0]).args().expect("args");
        assert!(a.enabled);
        assert_eq!(a.n, 0);
        let err = req(&fs[1]).args::<A>().err().expect("should fail");
        assert!(err.contains("enabled"), "{err}");
    }

    #[test]
    fn output_lines() {
        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let out = Output::new(buf.clone());
        out.reply_ok(&Value::from(1), Empty {}).unwrap();
        out.reply_ok(&Value::from(2), serde_json::json!({"text": "hi"})).unwrap();
        out.reply_err(&Value::Null, "bad").unwrap();
        out.event("hotkey", serde_json::json!({"state": "down"})).unwrap();
        let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            text,
            "{\"id\":1,\"ok\":true}\n{\"id\":2,\"ok\":true,\"text\":\"hi\"}\n\
             {\"id\":null,\"ok\":false,\"error\":\"bad\"}\n{\"event\":\"hotkey\",\"state\":\"down\"}\n"
        );
    }
}
