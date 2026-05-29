//! Steering delivery.
//!
//! The user queues steering messages (`POST /api/sessions/{name}/steer`);
//! this subsystem delivers them at the agent's next turn boundary — when the
//! session's status flips to `waiting` or `idle` — one at a time, exactly once.

pub mod deliver_loop;
