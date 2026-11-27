//! Opens a VSI with the native reader: `vsi_dump FILE` prints what it found; `vsi_dump FILE LEVEL X Y W H FRAME OUT.png` also
//! writes a region (X, Y in level-0 pixels, W x H in level pixels) as RGB composited on the background. Used to compare with slideio.
use exact_wsi::{vsi::Vsi, Slide};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let t = Instant::now();
    let v = match Vsi::open(&a[1]) {
        Ok(v) => v,
        Err(e) => {
            println!("NOT NATIVE: {e}");
            return;
        }
    };
    println!("open {:?}", t.elapsed());
    println!("levels {:?}", v.level_dimensions());
    println!("downsamples {:?}", v.level_downsamples());
    let mut p: Vec<_> = v.properties().into_iter().collect();
    p.sort();
    println!("props {p:?}");
    println!(
        "frames {} kind {:?} labels {:?}",
        v.frame_count(),
        v.frame_kind(),
        v.frame_labels().iter().take(3).collect::<Vec<_>>()
    );
    println!("aux {:?}", v.associated_images());
    if let Ok(dir) = std::env::var("AUX_DIR") {
        for n in v.associated_images() {
            let t = Instant::now();
            let img = v.associated_image(&n).unwrap();
            println!(
                "aux {n}: {}x{} in {:?}",
                img.width(),
                img.height(),
                t.elapsed()
            );
            img.save(format!("{dir}/{}.png", n.replace(' ', "_")))
                .unwrap();
        }
    }
    if a.len() >= 9 {
        let n = |i: usize| a[i].parse::<i64>().unwrap();
        let t = Instant::now();
        let r = v
            .read_region(
                n(3),
                n(4),
                n(2) as usize,
                n(5) as u32,
                n(6) as u32,
                n(7) as u32,
            )
            .unwrap();
        println!("read {:?}", t.elapsed());
        let rgb = exact_wsi::composite(&r, exact_wsi::background(&v.properties()));
        rgb.save(&a[8]).unwrap();
        let alpha0 = r.pixels().filter(|p| p[3] == 0).count();
        println!("transparent pixels {alpha0} of {}", r.width() * r.height());
    }
}
