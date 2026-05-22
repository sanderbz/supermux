//! Steering delivery (TECH_PLAN §3.9, feature-extract §5.6; M9).
//!
//! The user queues steering messages (`POST /api/sessions/{name}/steer`, M2);
//! this subsystem delivers them at the agent's next turn boundary — when the
//! session's status flips to `waiting` or `idle` — one at a time, exactly once.

pub mod deliver_loop;
