//! The server's warnings and errors, kept in memory for the administrators' log view (`GET /api/v2/admin/log`, see `v2/admin_log.rs`).
//! `exact-server` feeds it from `tracing` (a layer in `main.rs`); everything logged at WARN or ERROR lands here, with the text as it
//! goes to the console. The same message in a row is one entry with a count (a page of broken thumbnails does not push everything
//! else out). A restart of the server empties it; the console / journal keeps the full history.

use chrono::{DateTime, Utc};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

/// Messages kept.
pub const CAPACITY: usize = 2000;
/// How far back a repeated message is looked for.
const DEDUPE_WINDOW: usize = 300;
const MAX_MESSAGE: usize = 2000;

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: u64,
    pub first: DateTime<Utc>,
    pub last: DateTime<Utc>,
    pub count: u64,
    /// "WARN" or "ERROR"
    pub level: &'static str,
    pub target: String,
    pub message: String,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    /// newest last
    items: VecDeque<Entry>,
}

pub struct ErrorLog {
    inner: Mutex<Inner>,
    started: DateTime<Utc>,
}

impl ErrorLog {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            started: Utc::now(),
        }
    }

    pub fn started(&self) -> DateTime<Utc> {
        self.started
    }

    pub fn push(&self, level: &'static str, target: &str, mut message: String) {
        if message.len() > MAX_MESSAGE {
            let mut cut = MAX_MESSAGE;
            while !message.is_char_boundary(cut) {
                cut -= 1;
            }
            message.truncate(cut);
            message.push('…');
        }
        let now = Utc::now();
        let Ok(mut g) = self.inner.lock() else { return };
        let len = g.items.len();
        let same = (len.saturating_sub(DEDUPE_WINDOW)..len).rev().find(|&i| {
            g.items[i].level == level
                && g.items[i].target == target
                && g.items[i].message == message
        });
        if let Some(i) = same {
            // the repeat moves to the end, as the newest
            if let Some(mut e) = g.items.remove(i) {
                e.count += 1;
                e.last = now;
                g.items.push_back(e);
            }
            return;
        }
        g.next_id += 1;
        let id = g.next_id;
        g.items.push_back(Entry {
            id,
            first: now,
            last: now,
            count: 1,
            level,
            target: target.to_string(),
            message,
        });
        while g.items.len() > CAPACITY {
            g.items.pop_front();
        }
    }

    /// Newest first: those of at least `min_level` ("warn" or "error") that contain `q` (any case), at most `limit`; and how many matched.
    pub fn list(&self, errors_only: bool, q: &str, limit: usize) -> (Vec<Entry>, usize) {
        let q = q.to_lowercase();
        let Ok(g) = self.inner.lock() else {
            return (vec![], 0);
        };
        let hits: Vec<&Entry> = g
            .items
            .iter()
            .rev()
            .filter(|e| {
                (!errors_only || e.level == "ERROR")
                    && (q.is_empty()
                        || e.message.to_lowercase().contains(&q)
                        || e.target.to_lowercase().contains(&q))
            })
            .collect();
        let total = hits.len();
        (hits.into_iter().take(limit).cloned().collect(), total)
    }

    pub fn clear(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.items.clear();
        }
    }
}

pub fn global() -> &'static ErrorLog {
    static LOG: OnceLock<ErrorLog> = OnceLock::new();
    LOG.get_or_init(ErrorLog::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_are_counted_and_the_log_is_bounded() {
        let l = ErrorLog::new();
        l.push("WARN", "a", "same".into());
        l.push("ERROR", "a", "other".into());
        l.push("WARN", "a", "same".into());
        let (items, total) = l.list(false, "", 10);
        assert_eq!(total, 2);
        assert_eq!((items[0].message.as_str(), items[0].count), ("same", 2)); // the repeat is the newest
        assert_eq!(l.list(true, "", 10).1, 1);
        assert_eq!(l.list(false, "OTH", 10).1, 1);
        for i in 0..(CAPACITY + 50) {
            l.push("WARN", "a", format!("m{i}"));
        }
        assert_eq!(l.list(false, "", usize::MAX).1, CAPACITY);
        l.push("WARN", "a", "é".repeat(MAX_MESSAGE));
        assert!(l.list(false, "", 1).0[0].message.ends_with('…'));
        l.clear();
        assert_eq!(l.list(false, "", 10).1, 0);
    }
}
