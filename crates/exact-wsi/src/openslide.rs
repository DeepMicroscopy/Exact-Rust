//! Thin runtime binding to libopenslide (loaded with `dlopen`, so the server also starts, with the
//! OpenSlide formats disabled, when the library is missing).

use crate::{err, Result, Slide};
use image::RgbaImage;
use libloading::{Library, Symbol};
use std::{
    collections::HashMap,
    ffi::{c_char, c_double, c_void, CStr, CString},
    sync::OnceLock,
};

struct Api {
    _lib: Library,
    detect_vendor: unsafe extern "C" fn(*const c_char) -> *const c_char,
    open: unsafe extern "C" fn(*const c_char) -> *mut c_void,
    close: unsafe extern "C" fn(*mut c_void),
    get_error: unsafe extern "C" fn(*mut c_void) -> *const c_char,
    level_count: unsafe extern "C" fn(*mut c_void) -> i32,
    level_dimensions: unsafe extern "C" fn(*mut c_void, i32, *mut i64, *mut i64),
    level_downsample: unsafe extern "C" fn(*mut c_void, i32) -> c_double,
    best_level: unsafe extern "C" fn(*mut c_void, c_double) -> i32,
    read_region: unsafe extern "C" fn(*mut c_void, *mut u32, i64, i64, i32, i64, i64),
    property_names: unsafe extern "C" fn(*mut c_void) -> *const *const c_char,
    property_value: unsafe extern "C" fn(*mut c_void, *const c_char) -> *const c_char,
}

static API: OnceLock<Option<Api>> = OnceLock::new();

fn load() -> Option<Api> {
    let mut names: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("OPENSLIDE_LIB") {
        names.push(p);
    }
    for n in [
        "libopenslide.1.dylib",
        "/opt/homebrew/lib/libopenslide.1.dylib",
        "/usr/local/lib/libopenslide.1.dylib",
        "libopenslide.so.1",
        "libopenslide.so.0",
        "libopenslide-1.dll",
    ] {
        names.push(n.to_string());
    }
    let lib = names.iter().find_map(|n| unsafe { Library::new(n).ok() })?;
    unsafe {
        macro_rules! sym {
            ($n:literal) => {{
                let s: Symbol<_> = lib.get($n).ok()?;
                *s
            }};
        }
        Some(Api {
            detect_vendor: sym!(b"openslide_detect_vendor\0"),
            open: sym!(b"openslide_open\0"),
            close: sym!(b"openslide_close\0"),
            get_error: sym!(b"openslide_get_error\0"),
            level_count: sym!(b"openslide_get_level_count\0"),
            level_dimensions: sym!(b"openslide_get_level_dimensions\0"),
            level_downsample: sym!(b"openslide_get_level_downsample\0"),
            best_level: sym!(b"openslide_get_best_level_for_downsample\0"),
            read_region: sym!(b"openslide_read_region\0"),
            property_names: sym!(b"openslide_get_property_names\0"),
            property_value: sym!(b"openslide_get_property_value\0"),
            _lib: lib,
        })
    }
}

fn api() -> Option<&'static Api> {
    API.get_or_init(load).as_ref()
}

pub fn available() -> bool {
    api().is_some()
}

/// Vendor name OpenSlide detects for the file (`aperio`, `hamamatsu`, `generic-tiff`, ...), if any.
pub fn detect_vendor(path: &str) -> Option<String> {
    let api = api()?;
    let c = CString::new(path).ok()?;
    unsafe {
        let v = (api.detect_vendor)(c.as_ptr());
        (!v.is_null()).then(|| CStr::from_ptr(v).to_string_lossy().into_owned())
    }
}

pub struct OpenSlide {
    api: &'static Api,
    osr: *mut c_void,
    dims: Vec<(u64, u64)>,
    downs: Vec<f64>,
    props: HashMap<String, String>,
}

// libopenslide handles are documented thread-safe for reading.
unsafe impl Send for OpenSlide {}
unsafe impl Sync for OpenSlide {}

impl OpenSlide {
    pub fn open(path: &str) -> Result<Self> {
        let Some(api) = api() else {
            return err("libopenslide is not available");
        };
        let c = CString::new(path).map_err(|e| crate::WsiError(e.to_string()))?;
        unsafe {
            let osr = (api.open)(c.as_ptr());
            if osr.is_null() {
                return err("openslide cannot open the file");
            }
            let msg = (api.get_error)(osr);
            if !msg.is_null() {
                let m = CStr::from_ptr(msg).to_string_lossy().into_owned();
                (api.close)(osr);
                return err(m);
            }
            let n = (api.level_count)(osr);
            let (mut dims, mut downs) = (Vec::new(), Vec::new());
            for l in 0..n {
                let (mut w, mut h) = (0i64, 0i64);
                (api.level_dimensions)(osr, l, &mut w, &mut h);
                dims.push((w.max(0) as u64, h.max(0) as u64));
                downs.push((api.level_downsample)(osr, l));
            }
            let mut props = HashMap::new();
            let names = (api.property_names)(osr);
            let mut i = 0;
            while !names.is_null() && !(*names.add(i)).is_null() {
                let name = *names.add(i);
                let v = (api.property_value)(osr, name);
                if !v.is_null() {
                    props.insert(
                        CStr::from_ptr(name).to_string_lossy().into_owned(),
                        CStr::from_ptr(v).to_string_lossy().into_owned(),
                    );
                }
                i += 1;
            }
            Ok(Self {
                api,
                osr,
                dims,
                downs,
                props,
            })
        }
    }
}

impl Drop for OpenSlide {
    fn drop(&mut self) {
        unsafe { (self.api.close)(self.osr) }
    }
}

impl Slide for OpenSlide {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        self.dims.clone()
    }
    fn level_downsamples(&self) -> Vec<f64> {
        self.downs.clone()
    }
    fn best_level_for_downsample(&self, d: f64) -> usize {
        unsafe { (self.api.best_level)(self.osr, d).max(0) as usize }
    }
    fn properties(&self) -> HashMap<String, String> {
        self.props.clone()
    }
    fn read_region(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        _frame: u32,
    ) -> Result<RgbaImage> {
        if level >= self.dims.len() {
            return err("Invalid level");
        }
        let mut buf = vec![0u32; w as usize * h as usize];
        unsafe {
            (self.api.read_region)(
                self.osr,
                buf.as_mut_ptr(),
                x,
                y,
                level as i32,
                w as i64,
                h as i64,
            );
            let msg = (self.api.get_error)(self.osr);
            if !msg.is_null() {
                return err(CStr::from_ptr(msg).to_string_lossy().into_owned());
            }
        }
        // premultiplied ARGB -> straight RGBA
        let mut raw = Vec::with_capacity(buf.len() * 4);
        for p in buf {
            let (a, r, g, b) = ((p >> 24) & 255, (p >> 16) & 255, (p >> 8) & 255, p & 255);
            if a == 0 || a == 255 {
                raw.extend_from_slice(&[r as u8, g as u8, b as u8, a as u8]);
            } else {
                let un = |c: u32| ((c * 255 + a / 2) / a).min(255) as u8;
                raw.extend_from_slice(&[un(r), un(g), un(b), a as u8]);
            }
        }
        RgbaImage::from_raw(w, h, raw).ok_or_else(|| crate::WsiError("bad region".into()))
    }
}

/// Several independent OpenSlide handles of one file, each used by one request at a time. Concurrent
/// `read_region` calls on a single handle returned corrupted pixels for TIFF-based slides (found by comparing
/// parallel with sequential tile requests), so a handle is never shared between threads at the same moment.
pub struct OpenSlidePool {
    handles: Vec<std::sync::Mutex<OpenSlide>>,
    next: std::sync::atomic::AtomicUsize,
}

impl OpenSlidePool {
    pub fn open(path: &str) -> Result<Self> {
        let n = std::thread::available_parallelism()
            .map_or(2, |n| n.get())
            .clamp(2, 4);
        let handles = (0..n)
            .map(|_| OpenSlide::open(path).map(std::sync::Mutex::new))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            handles,
            next: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn first(&self) -> std::sync::MutexGuard<'_, OpenSlide> {
        self.handles[0].lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Slide for OpenSlidePool {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        self.first().level_dimensions()
    }
    fn level_downsamples(&self) -> Vec<f64> {
        self.first().level_downsamples()
    }
    fn best_level_for_downsample(&self, d: f64) -> usize {
        self.first().best_level_for_downsample(d)
    }
    fn properties(&self) -> HashMap<String, String> {
        self.first().properties()
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
        let n = self.handles.len();
        let start = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // prefer a free handle, otherwise wait for the next one in turn
        for i in 0..n {
            if let Ok(g) = self.handles[(start + i) % n].try_lock() {
                return g.read_region(x, y, level, w, h, frame);
            }
        }
        let g = self.handles[start % n]
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        g.read_region(x, y, level, w, h, frame)
    }
}
