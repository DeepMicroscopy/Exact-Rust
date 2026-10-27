//! MP4/AVI (and anything else libav decodes) as a time series of frames, in process through the system ffmpeg
//! libraries. Replaces `util/video_handler.py` (OpenCV). Frames are decoded sequentially where possible and
//! looked up by index: a seek lands on the preceding keyframe and decoding runs forward to the target frame.

use crate::{err, formats::crop_transparent, Result, Slide, WsiError};
use ffmpeg_next as ff;
use image::RgbaImage;
use moka::sync::Cache;
use std::{collections::HashMap, sync::Mutex};

struct Decoder {
    input: ff::format::context::Input,
    decoder: ff::decoder::Video,
    scaler: ff::software::scaling::Context,
    stream: usize,
    /// index of the frame decoded last; None right after a seek
    last: Option<i64>,
    eof: bool,
}

// The libav contexts are not thread-affine; they are only ever touched under the `Video::dec` mutex.
unsafe impl Send for Decoder {}

pub struct Video {
    path: String,
    width: u32,
    height: u32,
    frames: i64,
    pub fps: f64,
    pub codec: String,
    time_base: f64,
    start_pts: i64,
    dec: Mutex<Option<Decoder>>,
    cache: Cache<u32, std::sync::Arc<RgbaImage>>,
}

fn ferr(e: ff::Error) -> WsiError {
    WsiError(format!("video: {e}"))
}

impl Video {
    pub fn open(path: &str) -> Result<Self> {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let _ = ff::init();
            ff::util::log::set_level(ff::util::log::Level::Error);
        });
        let input = ff::format::input(&path).map_err(ferr)?;
        let st = input
            .streams()
            .best(ff::media::Type::Video)
            .ok_or_else(|| WsiError("no video stream".into()))?;
        // the nominal rate (as OpenCV reports it); the average rate drifts and would shift frame indices
        let nominal = st.rate();
        let rate = if nominal.denominator() != 0 && nominal.numerator() != 0 {
            nominal
        } else {
            st.avg_frame_rate()
        };
        let fps = if rate.denominator() != 0 {
            rate.numerator() as f64 / rate.denominator() as f64
        } else {
            0.0
        };
        let tb = st.time_base();
        let time_base = tb.numerator() as f64 / tb.denominator().max(1) as f64;
        let ctx = ff::codec::context::Context::from_parameters(st.parameters()).map_err(ferr)?;
        let codec = ctx.id().name().to_string();
        let video = ctx.decoder().video().map_err(ferr)?;
        let (width, height) = (video.width(), video.height());
        let mut frames = st.frames();
        if frames <= 0 && fps > 0.0 {
            frames = (st.duration() as f64 * time_base * fps).round() as i64;
        }
        if width == 0 || height == 0 || frames <= 0 {
            return err("video without frames");
        }
        let start = st.start_time();
        Ok(Self {
            path: path.to_string(),
            width,
            height,
            frames,
            fps,
            codec,
            time_base,
            start_pts: if start == ff::ffi::AV_NOPTS_VALUE {
                0
            } else {
                start
            },
            dec: Mutex::new(None),
            cache: Cache::new(32),
        })
    }

    pub fn frame_descriptors(&self) -> Vec<String> {
        (0..self.frames)
            .map(|i| format!("{:.2}", i as f64 / self.fps))
            .collect()
    }

    fn start(&self) -> Result<Decoder> {
        let input = ff::format::input(&self.path).map_err(ferr)?;
        let st = input
            .streams()
            .best(ff::media::Type::Video)
            .ok_or_else(|| WsiError("no video stream".into()))?;
        let stream = st.index();
        let ctx = ff::codec::context::Context::from_parameters(st.parameters()).map_err(ferr)?;
        let decoder = ctx.decoder().video().map_err(ferr)?;
        let scaler = ff::software::scaling::Context::get(
            decoder.format(),
            decoder.width(),
            decoder.height(),
            ff::format::Pixel::RGBA,
            decoder.width(),
            decoder.height(),
            ff::software::scaling::Flags::BILINEAR,
        )
        .map_err(ferr)?;
        Ok(Decoder {
            input,
            decoder,
            scaler,
            stream,
            last: None,
            eof: false,
        })
    }

    fn index_of(&self, pts: i64) -> i64 {
        (((pts - self.start_pts) as f64) * self.time_base * self.fps).round() as i64
    }

    /// Next decoded frame as RGBA with its index.
    fn next_frame(&self, d: &mut Decoder) -> Result<Option<(i64, RgbaImage)>> {
        let mut raw = ff::frame::Video::empty();
        loop {
            if d.decoder.receive_frame(&mut raw).is_ok() {
                let pts = raw.timestamp().or(raw.pts()).unwrap_or(0);
                let mut out = ff::frame::Video::empty();
                d.scaler.run(&raw, &mut out).map_err(ferr)?;
                let (w, h, stride) = (out.width() as usize, out.height() as usize, out.stride(0));
                let data = out.data(0);
                let mut buf = Vec::with_capacity(w * h * 4);
                for row in 0..h {
                    buf.extend_from_slice(&data[row * stride..row * stride + w * 4]);
                }
                let img = RgbaImage::from_raw(w as u32, h as u32, buf)
                    .ok_or_else(|| WsiError("bad frame".into()))?;
                return Ok(Some((self.index_of(pts), img)));
            }
            if d.eof {
                return Ok(None);
            }
            let mut sent = false;
            for (s, packet) in d.input.packets() {
                if s.index() == d.stream {
                    d.decoder.send_packet(&packet).map_err(ferr)?;
                    sent = true;
                    break;
                }
            }
            if !sent {
                d.eof = true;
                let _ = d.decoder.send_eof();
            }
        }
    }

    fn frame(&self, target: i64) -> Result<std::sync::Arc<RgbaImage>> {
        if let Some(f) = self.cache.get(&(target as u32)) {
            return Ok(f);
        }
        let mut guard = self.dec.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(self.start()?);
        }
        let d = guard.as_mut().expect("started");
        let near = d.last.is_some_and(|l| target > l && target - l <= 48);
        if !near {
            // seek to the keyframe before the target (AV_TIME_BASE units), then decode forward
            let ts = ((target as f64 / self.fps) * 1_000_000.0) as i64;
            let ts = (ts - 500_000).max(0);
            d.input.seek(ts, ..ts + 1).map_err(ferr)?;
            d.decoder.flush();
            d.last = None;
            d.eof = false;
        }
        loop {
            match self.next_frame(d)? {
                Some((idx, img)) => {
                    d.last = Some(idx);
                    let img = std::sync::Arc::new(img);
                    self.cache.insert(idx.max(0) as u32, img.clone());
                    if idx >= target {
                        return Ok(img);
                    }
                }
                None => {
                    *guard = None;
                    return err("frame not found");
                }
            }
        }
    }
}

impl Slide for Video {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        vec![(self.width as u64, self.height as u64)]
    }
    fn level_downsamples(&self) -> Vec<f64> {
        vec![1.0]
    }
    fn best_level_for_downsample(&self, _d: f64) -> usize {
        0
    }
    fn properties(&self) -> HashMap<String, String> {
        HashMap::from([
            ("openslide.background-color".into(), "000000".into()),
            ("openslide.mpp-x".into(), "0".into()),
            ("openslide.mpp-y".into(), "0".into()),
            ("openslide.objective-power".into(), "1".into()),
            ("openslide.vendor".into(), "MP4".into()),
        ])
    }
    fn frame_count(&self) -> u32 {
        self.frames as u32
    }
    fn frame_kind(&self) -> crate::FrameKind {
        crate::FrameKind::TimeSeries
    }
    fn frame_labels(&self) -> Vec<String> {
        self.frame_descriptors()
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
        if level != 0 {
            return err("Only level 0 is supported for video files.");
        }
        let idx = (frame as i64).clamp(0, self.frames - 1);
        match self.frame(idx) {
            Ok(img) => Ok(crop_transparent(&img, x, y, w, h)),
            // Django answers a failed frame read with a transparent tile
            Err(_) => Ok(RgbaImage::new(w, h)),
        }
    }
}
