//! System health for site admins: `GET /api/v2/health`. CPU load, GPU, storage, temperatures and the RAID, plus who is working
//! in the UI right now. The server reads what a container can see (`/proc`, `/sys/class/hwmon`, `nvidia-smi`, the volumes it has
//! mounted); what only the host knows (a hardware RAID controller, sensors behind IPMI) comes through a status file the host
//! writes (`EXACT_HOST_STATUS_FILE`, see `deploy/host-status.py`). A check that cannot be read is `unknown`, which is no alert.

use crate::{
    auth::{authenticate, require_user},
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use exact_db::users;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// A user counts as active for this long after the last request of their browser or token.
const ACTIVE_FOR: Duration = Duration::from_secs(5 * 60);
/// A status file the host has not rewritten for this long is itself an alert.
const HOST_FILE_STALE: Duration = Duration::from_secs(15 * 60);

/// Who was seen when (in memory: a restart of the server starts the list again).
#[derive(Default, Clone)]
pub struct Activity(Arc<Mutex<HashMap<i64, (String, Instant)>>>);

impl Activity {
    pub fn touch(&self, user_id: i64, username: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(user_id, (username.to_string(), Instant::now()));
        }
    }

    pub fn active(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .0
            .lock()
            .map(|m| {
                m.values()
                    .filter(|(_, at)| at.elapsed() < ACTIVE_FOR)
                    .map(|(n, _)| n.clone())
                    .collect()
            })
            .unwrap_or_default();
        names.sort_by_key(|n| n.to_lowercase());
        names
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/health", get(health_h))
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    Unknown,
    Ok,
    Warning,
    Critical,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Unknown => "unknown",
            Level::Ok => "ok",
            Level::Warning => "warning",
            Level::Critical => "critical",
        }
    }
}

fn check(
    id: &str,
    name: &str,
    level: Level,
    value: impl Into<String>,
    detail: impl Into<String>,
) -> (Level, Value) {
    (
        level,
        json!({"id": id, "name": name, "status": level.name(), "value": value.into(), "detail": detail.into()}),
    )
}

fn gib(bytes: u64) -> String {
    let t = bytes as f64 / (1024.0f64.powi(4));
    if t >= 1.0 {
        format!("{t:.1} TiB")
    } else {
        format!("{:.1} GiB", bytes as f64 / 1024.0f64.powi(3))
    }
}

// ---------------------------------------------------------------------------------------------------------
// readings
// ---------------------------------------------------------------------------------------------------------

/// Busy and total jiffies of all CPUs (`/proc/stat`, the host's even inside a container).
fn cpu_times() -> Option<(u64, u64)> {
    parse_cpu_times(&std::fs::read_to_string("/proc/stat").ok()?)
}

fn parse_cpu_times(text: &str) -> Option<(u64, u64)> {
    let v: Vec<u64> = text
        .lines()
        .next()?
        .split_whitespace()
        .skip(1)
        .filter_map(|x| x.parse().ok())
        .collect();
    if v.len() < 5 {
        return None;
    }
    let total: u64 = v.iter().take(8).sum(); // user nice system idle iowait irq softirq steal
    let idle = v[3] + v[4];
    Some((total - idle, total))
}

async fn cpu_percent() -> Option<f64> {
    let (b0, t0) = cpu_times()?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (b1, t1) = cpu_times()?;
    (t1 > t0).then(|| 100.0 * (b1 - b0) as f64 / (t1 - t0) as f64)
}

fn cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// The hottest sensor of `/sys/class/hwmon` as (label, degrees Celsius).
fn hottest_sensor() -> Option<(String, f64)> {
    let mut best: Option<(String, f64)> = None;
    for hw in std::fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
        let dir = hw.path();
        let chip = std::fs::read_to_string(dir.join("name"))
            .unwrap_or_default()
            .trim()
            .to_string();
        for e in std::fs::read_dir(&dir).ok()?.flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            let Some(stem) = file
                .strip_suffix("_input")
                .filter(|s| s.starts_with("temp"))
            else {
                continue;
            };
            let Some(milli) = std::fs::read_to_string(e.path())
                .ok()
                .and_then(|t| t.trim().parse::<f64>().ok())
            else {
                continue;
            };
            let label =
                std::fs::read_to_string(dir.join(format!("{stem}_label"))).unwrap_or_default();
            let degrees = milli / 1000.0;
            if degrees > 0.0 && best.as_ref().is_none_or(|(_, d)| degrees > *d) {
                best = Some((
                    format!("{chip} {}", label.trim()).trim().to_string(),
                    degrees,
                ));
            }
        }
    }
    best
}

struct Gpu {
    name: String,
    util: f64,
    mem_used: f64,
    mem_total: f64,
    temp: f64,
}

async fn gpus() -> Option<Vec<Gpu>> {
    let run = tokio::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let list = parse_gpus(&String::from_utf8_lossy(&out.stdout));
    (!list.is_empty()).then_some(list)
}

fn parse_gpus(csv: &str) -> Vec<Gpu> {
    csv.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            (f.len() == 5).then(|| Gpu {
                name: f[0].to_string(),
                util: f[1].parse().unwrap_or(0.0),
                mem_used: f[2].parse().unwrap_or(0.0),
                mem_total: f[3].parse().unwrap_or(0.0),
                temp: f[4].parse().unwrap_or(0.0),
            })
        })
        .collect()
}

/// (total, free) bytes of the file system `path` is on, and its device number (the same volume is listed once).
#[cfg(unix)]
fn volume(path: &Path) -> Option<(u64, u64, u64)> {
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    let dev = std::fs::metadata(path).ok()?.dev();
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let block = st.f_frsize as u64;
    Some((st.f_blocks as u64 * block, st.f_bavail as u64 * block, dev))
}

#[cfg(not(unix))]
fn volume(_: &Path) -> Option<(u64, u64, u64)> {
    None
}

/// What the host writes into the status file (all fields optional):
/// `{"raid": {"status": "ok|warning|critical", "detail": "..."}, "temperature_c": 41.5}`.
struct HostStatus {
    value: Value,
    age: Duration,
}

fn host_status() -> Result<Option<HostStatus>, String> {
    let Some(path) = std::env::var_os("EXACT_HOST_STATUS_FILE").filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let age = match std::fs::metadata(&path).and_then(|m| m.modified()) {
        Ok(t) => t.elapsed().unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None), // never set up: no alert
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value =
        serde_json::from_str(&text).map_err(|e| format!("{}: not JSON ({e})", path.display()))?;
    Ok(Some(HostStatus { value, age }))
}

fn level_of(s: &str) -> Level {
    match s.to_lowercase().as_str() {
        "ok" | "optimal" | "good" | "online" => Level::Ok,
        "warning" | "degraded" | "rebuilding" | "partially degraded" => Level::Warning,
        "critical" | "failed" | "offline" | "error" => Level::Critical,
        _ => Level::Unknown,
    }
}

// ---------------------------------------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------------------------------------

async fn health_h(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    if !users::is_site_admin(&s.pool, p.user.id).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Site admin permission required.",
        ));
    }
    let mut checks: Vec<(Level, Value)> = vec![];

    // CPU: the load of all cores over a third of a second
    checks.push(match cpu_percent().await {
        Some(c) => {
            let level = if c >= 95.0 {
                Level::Critical
            } else if c >= 85.0 {
                Level::Warning
            } else {
                Level::Ok
            };
            check(
                "cpu",
                "CPU utilization",
                level,
                format!("{c:.0} %"),
                format!(
                    "{} cores; warning from 85 %, critical from 95 %",
                    cpu_count()
                ),
            )
        }
        None => check(
            "cpu",
            "CPU utilization",
            Level::Unknown,
            "n/a",
            "The server cannot read /proc/stat on this system.",
        ),
    });

    // GPU
    let gpu_list = gpus().await;
    checks.push(match &gpu_list {
        Some(list) => {
            let value = list
                .iter()
                .map(|g| format!("{:.0} %", g.util))
                .collect::<Vec<_>>()
                .join(", ");
            let detail = list
                .iter()
                .map(|g| {
                    format!(
                        "{}: {:.0} of {:.0} MiB memory, {:.0} °C",
                        g.name, g.mem_used, g.mem_total, g.temp
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            check("gpu", "GPU utilization", Level::Ok, value, detail)
        }
        None => check(
            "gpu",
            "GPU utilization",
            Level::Unknown,
            "n/a",
            "No NVIDIA GPU is visible to the server (nvidia-smi).",
        ),
    });

    // active users
    let active = s.activity.active();
    checks.push(check(
        "users",
        "Active users",
        Level::Ok,
        active.len().to_string(),
        if active.is_empty() {
            "Nobody in the last 5 minutes.".to_string()
        } else {
            format!("{} (last 5 minutes)", active.join(", "))
        },
    ));

    // the host's file: RAID and, when the container sees no sensors, the temperature
    let host = host_status();
    checks.push(match &host {
        Ok(Some(h)) => {
            let raid = h.value.get("raid");
            let status = raid.and_then(|r| r.get("status")).and_then(Value::as_str).unwrap_or("unknown");
            let detail = raid.and_then(|r| r.get("detail")).and_then(Value::as_str).unwrap_or("");
            let mut level = level_of(status);
            let mut detail = detail.to_string();
            if h.age > HOST_FILE_STALE {
                level = level.max(Level::Warning);
                detail = format!("{detail} (the host has not updated its status for {} minutes)", h.age.as_secs() / 60).trim().to_string();
            }
            check("raid", "RAID status", level, status, detail)
        }
        Ok(None) => check("raid", "RAID status", Level::Unknown, "n/a", "Not set up: the host writes the status into a file (EXACT_HOST_STATUS_FILE, deploy/host-status.py)."),
        Err(e) => check("raid", "RAID status", Level::Warning, "unreadable", e.clone()),
    });

    // temperature: the hottest sensor the server sees, the GPU, or what the host reports
    let mut temps: Vec<(String, f64)> = vec![];
    if let Some(t) = hottest_sensor() {
        temps.push(t);
    }
    if let Some(list) = &gpu_list {
        if let Some(g) = list.iter().max_by(|a, b| a.temp.total_cmp(&b.temp)) {
            temps.push((format!("GPU {}", g.name), g.temp));
        }
    }
    if let Ok(Some(h)) = &host {
        if let Some(t) = h.value.get("temperature_c").and_then(Value::as_f64) {
            temps.push(("host".to_string(), t));
        }
    }
    checks.push(match temps.iter().max_by(|a, b| a.1.total_cmp(&b.1)) {
        Some((_, t)) => {
            let level = if *t >= 90.0 {
                Level::Critical
            } else if *t >= 80.0 {
                Level::Warning
            } else {
                Level::Ok
            };
            let detail = format!(
                "{}; warning from 80 °C, critical from 90 °C",
                temps
                    .iter()
                    .map(|(l, t)| format!("{l} {t:.0} °C"))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            check(
                "temperature",
                "Temperature",
                level,
                format!("{t:.0} °C"),
                detail,
            )
        }
        None => check(
            "temperature",
            "Temperature",
            Level::Unknown,
            "n/a",
            "No sensor is visible to the server; the host can report one in its status file.",
        ),
    });

    // storage: the volumes of the image store, the media files and the cache (one line per file system)
    let mut seen = vec![];
    let mut storage = vec![];
    let mut disk_level = Level::Ok;
    for (name, path) in [
        ("Images", s.slides.root().to_path_buf()),
        ("Media", s.media_root.clone()),
        ("Cache", s.slides.cache_dir().to_path_buf()),
    ] {
        let Some((total, free, dev)) = volume(&path) else {
            continue;
        };
        if seen.contains(&dev) {
            continue;
        }
        seen.push(dev);
        let share = if total > 0 {
            free as f64 / total as f64
        } else {
            1.0
        };
        let level = if share < 0.05 {
            Level::Critical
        } else if share < 0.10 {
            Level::Warning
        } else {
            Level::Ok
        };
        disk_level = disk_level.max(level);
        storage.push(json!({"name": name, "path": path.to_string_lossy(), "total": total, "free": free, "used": total - free, "status": level.name()}));
    }
    checks.push(if storage.is_empty() {
        check(
            "storage",
            "Free space",
            Level::Unknown,
            "n/a",
            "The volumes cannot be read.",
        )
    } else {
        let detail = storage
            .iter()
            .map(|v| {
                format!(
                    "{}: {} free of {}",
                    v["name"].as_str().unwrap_or(""),
                    gib(v["free"].as_u64().unwrap_or(0)),
                    gib(v["total"].as_u64().unwrap_or(0))
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        check(
            "storage",
            "Free space",
            disk_level,
            if storage.len() == 1 {
                "1 volume".to_string()
            } else {
                format!("{} volumes", storage.len())
            },
            format!("{detail}; warning below 10 % free, critical below 5 %"),
        )
    });

    let overall = checks.iter().map(|(l, _)| *l).fold(Level::Ok, Level::max);
    Ok(Json(json!({
        "status": overall.name(),
        "checked_at": chrono::Utc::now(),
        "checks": checks.into_iter().map(|(_, c)| c).collect::<Vec<_>>(),
        "storage": storage,
        "active_users": active,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_times_leave_out_idle_and_iowait() {
        // user nice system idle iowait irq softirq steal guest guest_nice
        let (busy, total) =
            parse_cpu_times("cpu  100 0 50 800 40 5 5 0 0 0\ncpu0 1 1 1 1 1 1 1 1\n").unwrap();
        assert_eq!((busy, total), (160, 1000));
        assert!(parse_cpu_times("garbage").is_none());
    }

    #[test]
    fn nvidia_smi_lines() {
        let g = parse_gpus("NVIDIA GeForce RTX 2060, 37, 2134, 6144, 61\n");
        assert_eq!(g.len(), 1);
        assert_eq!(
            (
                g[0].name.as_str(),
                g[0].util,
                g[0].mem_used,
                g[0].mem_total,
                g[0].temp
            ),
            ("NVIDIA GeForce RTX 2060", 37.0, 2134.0, 6144.0, 61.0)
        );
        assert!(parse_gpus("No devices were found\n").is_empty());
    }

    #[test]
    fn raid_words_map_to_levels() {
        assert!(
            level_of("Optimal") == Level::Ok
                && level_of("Degraded") == Level::Warning
                && level_of("Failed") == Level::Critical
        );
        assert!(level_of("whatever") == Level::Unknown);
    }

    #[test]
    fn active_users_are_sorted_and_listed_once() {
        let a = Activity::default();
        a.touch(2, "bruno");
        a.touch(1, "Anna");
        a.touch(2, "bruno");
        assert_eq!(a.active(), vec!["Anna", "bruno"]);
    }
}
