//! supermux server library crate.
//!
//! Exposes the persistence, auth, config, and HTTP layers as a library so the
//! binary (`main.rs`) and the integration tests (`tests/`) share one
//! definition. Modules map 1:1 to TECH_PLAN §3.2.

pub mod agents;
pub mod audit;
pub mod auth;
pub mod board;
pub mod claude_config;
pub mod config;
pub mod db;
pub mod error;
pub mod files;
pub mod hooks;
pub mod http;
pub mod log_redact;
pub mod prefs;
pub mod public;
pub mod scheduler;
pub mod sessions;
pub mod sse;
pub mod state;
pub mod static_assets;
pub mod ws;
