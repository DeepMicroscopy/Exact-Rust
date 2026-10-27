//! Domain types and pure logic shared by all crates (no I/O).

pub mod config;
pub mod error;

pub use config::Config;
pub use error::{Error, Result};
