//! CZI, VSI and DICOM through a helper process (`helpers/slideio_helper.py`, see its header for the protocol).
//! The helper is kept out of process: a crash only fails the request, the pool restarts it.

use crate::{err, Result, Slide, WsiError};
use image::RgbaImage;
use std::{
    collections::HashMap,
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// One helper process and what is known about it from here: the slides it has open (the helper keeps the last `MAX_OPEN`,
/// see `SLIDEIO_MAX_OPEN` there) and how many requests are on their way to it.
struct Slot {
    proc: Mutex<Option<Proc>>,
    open: Mutex<VecDeque<String>>,
    waiting: AtomicUsize,
}

struct Pool {
    python: String,
    script: PathBuf,
    procs: Vec<Slot>,
    next: AtomicUsize,
    max_open: usize,
    timing: Timing,
}

/// How long a request takes at a helper, as a moving average (microseconds): a first request for a slide, which has the helper open it
/// (0.2 s to over a second for a VSI with many stack folders), and one for a slide it has open (some milliseconds per tile).
struct Timing {
    open_us: AtomicU64,
    read_us: AtomicU64,
}

impl Timing {
    fn average(of: &AtomicU64, took: Duration) {
        let old = of.load(Ordering::Relaxed);
        let new = took.as_micros().min(60_000_000) as u64;
        of.store(
            if old == 0 { new } else { (old * 7 + new) / 8 },
            Ordering::Relaxed,
        );
    }

    /// Queued requests at a helper from which on another helper, which has to open the slide first, is the quicker one.
    fn overflow(&self) -> usize {
        let open = self.open_us.load(Ordering::Relaxed).max(1);
        let read = self.read_us.load(Ordering::Relaxed);
        // not measured yet: a read is some ms, an open about a second
        let (open, read) = if read == 0 {
            (1_000_000, 10_000)
        } else {
            (open, read)
        };
        ((open / read.max(1)) as usize).clamp(2, 256)
    }
}

/// The helper for a request: one that has the slide open (the least busy of them) as opening a slide costs far more than a
/// read; only when that one is swamped, or none has it open, the least busy of the others (ties go to `start` and on).
fn route(loads: &[usize], has: &[bool], start: usize, overflow: usize) -> usize {
    let n = loads.len();
    let order = (0..n).map(|i| (start + i) % n);
    let least = |of: &mut dyn Iterator<Item = usize>| of.min_by_key(|&i| loads[i]);
    let owner = least(&mut order.clone().filter(|&i| has[i]));
    let other = least(&mut order.clone().filter(|&i| !has[i]));
    match (owner, other) {
        (Some(o), Some(x)) if loads[o] >= overflow && loads[x] < loads[o] => x,
        (Some(o), _) => o,
        (None, Some(x)) => x,
        (None, None) => start % n.max(1),
    }
}

static POOL: OnceLock<Option<Pool>> = OnceLock::new();

fn script_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SLIDEIO_HELPER") {
        return Some(p.into());
    }
    let exe = std::env::current_exe().ok()?;
    let mut candidates = vec![];
    for up in exe.ancestors().skip(1).take(5) {
        candidates.push(up.join("helpers/slideio_helper.py"));
        candidates.push(up.join("slideio_helper.py"));
    }
    candidates.into_iter().find(|p| p.exists())
}

fn pool() -> Option<&'static Pool> {
    POOL.get_or_init(|| {
        let script = script_path()?;
        let python = std::env::var("SLIDEIO_PYTHON").unwrap_or_else(|_| "python3".into());
        let n = std::env::var("SLIDEIO_WORKERS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4usize)
            .max(1);
        Some(Pool {
            python,
            script,
            procs: (0..n)
                .map(|_| Slot {
                    proc: Mutex::new(None),
                    open: Mutex::new(VecDeque::new()),
                    waiting: AtomicUsize::new(0),
                })
                .collect(),
            next: AtomicUsize::new(0),
            timing: Timing {
                open_us: AtomicU64::new(0),
                read_us: AtomicU64::new(0),
            },
            max_open: std::env::var("SLIDEIO_MAX_OPEN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(12usize)
                .max(1),
        })
    })
    .as_ref()
}

pub fn available() -> bool {
    pool().is_some()
}

impl Pool {
    fn spawn(&self) -> Result<Proc> {
        let mut child = Command::new(&self.python)
            .arg("-I")
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| WsiError(format!("cannot start slideio helper: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| WsiError("no helper stdin".into()))?;
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| WsiError("no helper stdout".into()))?,
        );
        Ok(Proc {
            child,
            stdin,
            stdout,
        })
    }

    /// Sends one request; returns the answer header and payload. A broken helper is replaced and the call retried once.
    /// The helper is the one that has the slide of the request open already (see `route`).
    fn call(&self, req: &serde_json::Value) -> Result<(serde_json::Value, Vec<u8>)> {
        let path = req["path"].as_str().unwrap_or("");
        let has: Vec<bool> = self
            .procs
            .iter()
            .map(|s| {
                s.open
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .any(|p| p == path)
            })
            .collect();
        let loads: Vec<usize> = self
            .procs
            .iter()
            .map(|s| s.waiting.load(Ordering::Relaxed))
            .collect();
        let slot = &self.procs[route(
            &loads,
            &has,
            self.next.fetch_add(1, Ordering::Relaxed),
            self.timing.overflow(),
        )];
        slot.waiting.fetch_add(1, Ordering::Relaxed);
        let done = Waiting(&slot.waiting);
        let mut guard = slot.proc.lock().unwrap_or_else(|e| e.into_inner());
        let mut result = err("slideio helper failed");
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.spawn()?);
                slot.open.lock().unwrap_or_else(|e| e.into_inner()).clear();
            }
            let p = guard.as_mut().expect("spawned");
            let started = Instant::now();
            match Self::exchange(p, req) {
                Ok(v) => {
                    // only requests that were not delayed by a failed first try tell how long a read or an open takes
                    if attempt == 0 && v.0["ok"] == true {
                        let had = has_open(slot, path);
                        Timing::average(
                            if had {
                                &self.timing.read_us
                            } else {
                                &self.timing.open_us
                            },
                            started.elapsed(),
                        );
                    }
                    result = Ok(v);
                    break;
                }
                Err(e) if attempt == 1 => {
                    result = Err(e);
                    break;
                }
                Err(_) => {
                    if let Some(mut dead) = guard.take() {
                        let _ = dead.child.kill();
                    }
                    slot.open.lock().unwrap_or_else(|e| e.into_inner()).clear();
                }
            }
        }
        drop(done);
        // the helper has the slide open now, and keeps only its last `max_open`
        if !path.is_empty() && result.as_ref().is_ok_and(|(h, _)| h["ok"] == true) {
            let mut open = slot.open.lock().unwrap_or_else(|e| e.into_inner());
            open.retain(|p| p != path);
            open.push_back(path.to_string());
            while open.len() > self.max_open {
                open.pop_front();
            }
        }
        result
    }

    fn exchange(p: &mut Proc, req: &serde_json::Value) -> Result<(serde_json::Value, Vec<u8>)> {
        let io = |e: std::io::Error| WsiError(format!("slideio helper: {e}"));
        writeln!(p.stdin, "{req}").map_err(io)?;
        p.stdin.flush().map_err(io)?;
        let mut line = String::new();
        if p.stdout.read_line(&mut line).map_err(io)? == 0 {
            return err("slideio helper exited");
        }
        let head: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| WsiError(e.to_string()))?;
        let len = head["payload_len"].as_u64().unwrap_or(0) as usize;
        let mut payload = vec![0u8; len];
        p.stdout.read_exact(&mut payload).map_err(io)?;
        Ok((head, payload))
    }
}

fn has_open(slot: &Slot, path: &str) -> bool {
    slot.open
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|p| p == path)
}

/// Counts a request as waiting at a helper until it is answered.
struct Waiting<'a>(&'a AtomicUsize);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The integer downsample when `down` is within 1% of one (slideio levels are exact 2^k decimation grids).
fn exact_downsample(down: f64) -> Option<f64> {
    let ds = down.round();
    (ds >= 1.0 && (down - ds).abs() <= 0.01 * ds).then_some(ds)
}

pub struct SlideIo {
    pool: &'static Pool,
    path: String,
    levels: Vec<(u64, u64, f64)>,
    props: HashMap<String, String>,
    frames: u32,
    pub frame_descriptors: Vec<String>,
    kind: crate::FrameKind,
    z_positions: Option<(Vec<f64>, String)>,
    aux: Vec<String>,
}

impl SlideIo {
    pub fn open(path: &str) -> Result<Self> {
        let Some(pool) = pool() else {
            return err("slideio helper not found (set SLIDEIO_HELPER)");
        };
        let (h, _) = pool.call(&serde_json::json!({"op": "open", "path": path}))?;
        if h["ok"] != true {
            return err(h["error"]
                .as_str()
                .unwrap_or("slideio cannot open the file"));
        }
        let levels = h["levels"]
            .as_array()
            .ok_or_else(|| WsiError("no levels".into()))?
            .iter()
            .map(|l| {
                (
                    l["w"].as_u64().unwrap_or(0),
                    l["h"].as_u64().unwrap_or(0),
                    l["scale"].as_f64().unwrap_or(1.0),
                )
            })
            .collect();
        let mut props = HashMap::new();
        props.insert("openslide.background-color".into(), "000000".into());
        props.insert(
            "openslide.mpp-x".into(),
            h["mpp_x"].as_f64().unwrap_or(0.0).to_string(),
        );
        props.insert(
            "openslide.mpp-y".into(),
            h["mpp_y"].as_f64().unwrap_or(0.0).to_string(),
        );
        props.insert(
            "openslide.objective-power".into(),
            h["magnification"].as_f64().unwrap_or(0.0).to_string(),
        );
        Ok(Self {
            pool,
            path: path.to_string(),
            levels,
            props,
            frames: h["frames"].as_u64().unwrap_or(1) as u32,
            aux: h["aux"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            kind: match h["kind"].as_str() {
                Some("zstack") => crate::FrameKind::ZStack,
                Some("volume") => crate::FrameKind::Volume,
                Some("timeseries") => crate::FrameKind::TimeSeries,
                _ => crate::FrameKind::None,
            },
            z_positions: h["z_positions"].as_array().map(|a| {
                (
                    a.iter().filter_map(|v| v.as_f64()).collect(),
                    h["z_unit"].as_str().unwrap_or("µm").to_string(),
                )
            }),
            frame_descriptors: h["frame_descriptors"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

impl Slide for SlideIo {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        self.levels.iter().map(|l| (l.0, l.1)).collect()
    }
    /// Size of a level pixel in level-0 pixels. slideio reports `1 / scale` (16.0007 for a 16:1 level) because it derives
    /// the scale from rounded level sizes, but the levels are exact decimation grids (measured: zero shift against level
    /// 0 reduced by exactly 16), so the integer downsample is the true pixel size.
    fn level_downsamples(&self) -> Vec<f64> {
        self.levels
            .iter()
            .map(|l| exact_downsample(1.0 / l.2).unwrap_or(1.0 / l.2))
            .collect()
    }
    /// numpy `argmin(|downsamples - d|)` as in `SlideIOSlide.get_best_level_for_downsample`
    fn best_level_for_downsample(&self, d: f64) -> usize {
        let mut best = (0, f64::INFINITY);
        for (i, l) in self.levels.iter().enumerate() {
            let diff = (exact_downsample(1.0 / l.2).unwrap_or(1.0 / l.2) - d).abs();
            if diff < best.1 {
                best = (i, diff);
            }
        }
        best.0
    }
    fn properties(&self) -> HashMap<String, String> {
        self.props.clone()
    }
    fn needs_registration(&self) -> bool {
        true
    }
    fn frame_kind(&self) -> crate::FrameKind {
        self.kind
    }
    fn frame_labels(&self) -> Vec<String> {
        self.frame_descriptors.clone()
    }
    fn z_positions(&self) -> Option<(Vec<f64>, String)> {
        self.z_positions.clone()
    }
    fn associated_images(&self) -> Vec<String> {
        self.aux.clone()
    }
    fn associated_image(&self, name: &str) -> Result<image::RgbImage> {
        if !self.aux.iter().any(|n| n == name) {
            return err("no such associated image");
        }
        let (head, payload) = self
            .pool
            .call(&serde_json::json!({"op": "aux", "path": self.path, "name": name}))?;
        if head["ok"] != true {
            return err(head["error"].as_str().unwrap_or("read failed"));
        }
        let (w, h) = (
            head["w"].as_u64().unwrap_or(0) as u32,
            head["h"].as_u64().unwrap_or(0) as u32,
        );
        image::RgbImage::from_raw(w, h, payload).ok_or_else(|| WsiError("bad image size".into()))
    }
    fn frame_count(&self) -> u32 {
        self.frames
    }
    fn read_region(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        frame: u32,
    ) -> Result<RgbaImage> {
        if level >= self.levels.len() {
            return err("Invalid level");
        }
        // slideio snaps a requested region to its level grid and the result is displaced by up to a level pixel when the
        // position is not a multiple of the downsample (measured: 0.0 px at multiples, 0.8-1.4 px otherwise). The positions
        // come from the exact integer downsample (see `level_downsamples`); the region is requested with exactly that size.
        let down = 1.0 / self.levels[level].2;
        let exact = exact_downsample(down);
        let snap = |v: i64| exact.map_or(v, |ds| ((v as f64 / ds).round() * ds) as i64);
        let (x, y) = (snap(x), snap(y));
        let mut req = serde_json::json!({
            "op": "read", "path": self.path, "x": x, "y": y, "w": w, "h": h, "level": level,
            "frame": frame.min(self.frames.saturating_sub(1)),
        });
        if let Some(ds) = exact {
            req["ds"] = serde_json::json!(ds as i64);
        }
        let (head, payload) = self.pool.call(&req)?;
        if head["ok"] != true {
            return err(head["error"].as_str().unwrap_or("read failed"));
        }
        RgbaImage::from_raw(w, h, payload).ok_or_else(|| WsiError("bad region size".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::{route, Timing};
    const OVERFLOW: usize = 12;

    #[test]
    fn a_slide_stays_with_the_helper_that_has_it_open() {
        // helper 2 has it: it is used although the others are idle
        assert_eq!(
            route(&[0, 0, 3, 0], &[false, false, true, false], 0, OVERFLOW),
            2
        );
        // two have it: the less busy one
        assert_eq!(
            route(&[0, 5, 2, 0], &[false, true, true, false], 0, OVERFLOW),
            2
        );
    }

    #[test]
    fn a_new_slide_goes_to_the_least_busy_helper_starting_at_the_turn() {
        assert_eq!(route(&[1, 0, 0, 1], &[false; 4], 0, OVERFLOW), 1);
        assert_eq!(route(&[1, 0, 0, 1], &[false; 4], 2, OVERFLOW), 2);
        assert_eq!(route(&[0, 0, 0, 0], &[false; 4], 7, OVERFLOW), 3);
    }

    #[test]
    fn a_swamped_owner_hands_over_to_an_idle_helper() {
        assert_eq!(route(&[OVERFLOW, 0], &[true, false], 0, OVERFLOW), 1);
        // below the limit the owner keeps it, and a helper that is not less busy does not take over
        assert_eq!(route(&[OVERFLOW - 1, 0], &[true, false], 0, OVERFLOW), 0);
        assert_eq!(route(&[OVERFLOW, OVERFLOW], &[true, false], 0, OVERFLOW), 0);
    }

    #[test]
    fn the_overflow_follows_what_an_open_costs_against_a_read() {
        use std::{sync::atomic::AtomicU64, time::Duration};
        let t = Timing {
            open_us: AtomicU64::new(0),
            read_us: AtomicU64::new(0),
        };
        assert_eq!(t.overflow(), 100); // nothing measured: 1 s against 10 ms
        Timing::average(&t.read_us, Duration::from_millis(10));
        Timing::average(&t.open_us, Duration::from_millis(500));
        assert_eq!(t.overflow(), 50);
        // heavy reads (a 100 ms decode): hand over after a few
        let slow = Timing {
            open_us: AtomicU64::new(500_000),
            read_us: AtomicU64::new(100_000),
        };
        assert_eq!(slow.overflow(), 5);
    }
}
