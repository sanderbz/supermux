//! amux-v3 server library crate.
//!
//! Exposes the persistence, auth, config, and HTTP layers as a library so the
//! binary (`main.rs`) and the integration tests (`tests/`) share one
//! definition. Modules map 1:1 to TECH_PLAN §3.2.

pub mod auth;
pub mod board;
pub mod config;
pub mod db;
pub mod error;
pub mod files;
pub mod http;
pub mod public;
pub mod sessions;
pub mod state;
pub mod ws;
