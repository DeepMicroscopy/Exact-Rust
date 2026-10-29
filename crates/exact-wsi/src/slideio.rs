//! CZI, VSI and DICOM through a helper process (`helpers/slideio_helper.py`, see its header for the protocol).
//! The helper is kept out of process: a crash only fails the request, the pool restarts it.

use crate::{err, Result, Slide, WsiError};
use image::RgbaImage;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
};

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct Pool {
    python: String,
    script: PathBuf,
    procs: Vec<Mutex<Option<Proc>>>,
    next: AtomicUsize,
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
            procs: (0..n).map(|_| Mutex::new(None)).collect(),
            next: AtomicUsize::new(0),
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
    fn call(&self, req: &serde_json::Value) -> Result<(serde_json::Value, Vec<u8>)> {
        let slot = &self.procs[self.next.fetch_add(1, Ordering::Relaxed) % self.procs.len()];
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.spawn()?);
            }
            let p = guard.as_mut().expect("spawned");
            match Self::exchange(p, req) {
                Ok(v) => return Ok(v),
                Err(e) if attempt == 1 => return Err(e),
                Err(_) => {
                    if let Some(mut dead) = guard.take() {
                        let _ = dead.child.kill();
                    }
                }
            }
        }
        err("slideio helper failed")
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
