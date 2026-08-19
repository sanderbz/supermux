//! The **AGENT / HUMAN drive lock** — one per browser context.
//!
//! The shared browser is exactly that: *shared*. An agent drives it through
//! tool calls (phase 3), and at any moment the human can grab the wheel from
//! the takeover UI (phase 2) to solve a captcha, sign in, or click the thing
//! the agent cannot see. Both hands on the wheel is the failure mode this
//! exists to make impossible.
//!
//! # Why a watch channel and not a `Mutex`
//!
//! A mutex would model "one at a time" but not the two things we actually need:
//!
//! 1. **Read the mode without acquiring anything.** Every agent action starts
//!    with a cheap [`ensure_agent`](DriveLock::ensure_agent) check, and the UI
//!    polls/streams the current mode. A mutex read is a contended acquire.
//! 2. **Await a transition.** Phase 2's "queue until the human is done"
//!    behaviour ([`await_agent`](DriveLock::await_agent)) is a *wait for a state
//!    change*, which is precisely a [`tokio::sync::watch`] subscription — and
//!    it also gives the UI a free change-notification channel.
//!
//! Takeover is therefore **not** a fair queue and deliberately so: the human
//! always wins immediately, and the agent is refused (or parks) until released.
//!
//! # What phase 2/3 add
//!
//! * Phase 2 wires [`request_human_takeover`](DriveLock::request_human_takeover)
//!   to also pause the agent's pty and gate its input.
//! * Phase 3 calls [`ensure_agent`](DriveLock::ensure_agent) from every MCP
//!   browser tool before it touches the page.
//!
//! Both of those hang off this type; the state machine itself is complete here.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::error::BrowserError;

/// Who currently owns a browser context's input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveMode {
    /// The agent may navigate/click/type. The resting state.
    AgentDriving,
    /// A human has taken over from the UI; agent input is refused.
    HumanDriving,
}

impl DriveMode {
    /// Is the agent allowed to act right now?
    pub fn agent_may_act(self) -> bool {
        matches!(self, DriveMode::AgentDriving)
    }
}

impl std::fmt::Display for DriveMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DriveMode::AgentDriving => f.write_str("AGENT_DRIVING"),
            DriveMode::HumanDriving => f.write_str("HUMAN_DRIVING"),
        }
    }
}

/// Who is attempting an action. Distinguishing these is the whole point: the
/// same [`super::context::AgentContext`] method serves the agent's tool call
/// and the human's takeover click, and only one of them is gated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    /// An agent tool call (phase 3). Gated by the lock.
    Agent,
    /// A human action relayed from the takeover UI (phase 2). Never gated —
    /// the human is the escalation path and must always get through.
    Human,
}

/// The per-context drive-lock state machine.
#[derive(Debug)]
pub struct DriveLock {
    session: String,
    tx: watch::Sender<DriveMode>,
}

impl DriveLock {
    /// A fresh lock, resting in [`DriveMode::AgentDriving`].
    pub fn new(session: impl Into<String>) -> Self {
        let (tx, _rx) = watch::channel(DriveMode::AgentDriving);
        Self {
            session: session.into(),
            tx,
        }
    }

    /// The session this lock guards.
    pub fn session(&self) -> &str {
        &self.session
    }

    /// Current mode. Lock-free read.
    pub fn mode(&self) -> DriveMode {
        *self.tx.borrow()
    }

    /// Subscribe to mode changes (the UI's live indicator; phase 2's pty gate).
    pub fn subscribe(&self) -> watch::Receiver<DriveMode> {
        self.tx.subscribe()
    }

    /// **The human grabs the wheel.** Returns the mode it replaced, so a
    /// caller can tell a real takeover from a redundant click. Idempotent.
    pub fn request_human_takeover(&self) -> DriveMode {
        let previous = self.mode();
        // `send_replace` fires watchers even when the value is unchanged only
        // if it differs; either way the stored value ends up HumanDriving.
        self.tx.send_replace(DriveMode::HumanDriving);
        previous
    }

    /// **The human hands the wheel back.** Returns the mode it replaced.
    /// Idempotent.
    pub fn release_to_agent(&self) -> DriveMode {
        let previous = self.mode();
        self.tx.send_replace(DriveMode::AgentDriving);
        previous
    }

    /// The gate every agent-initiated action must pass.
    ///
    /// `Ok(())` while the agent drives; [`BrowserError::HumanDriving`]
    /// otherwise. Cheap enough to call per keystroke.
    pub fn ensure_agent(&self) -> Result<(), BrowserError> {
        match self.mode() {
            DriveMode::AgentDriving => Ok(()),
            DriveMode::HumanDriving => Err(BrowserError::HumanDriving {
                session: self.session.clone(),
            }),
        }
    }

    /// The *queueing* variant of [`ensure_agent`](Self::ensure_agent): park
    /// until the human releases, or give up after `timeout`.
    ///
    /// Phase 3 picks per tool: a click should refuse fast (the agent can
    /// re-plan), a long-running "wait for this page" may prefer to park.
    pub async fn await_agent(&self, timeout: Duration) -> Result<(), BrowserError> {
        let mut rx = self.tx.subscribe();
        if rx.borrow_and_update().agent_may_act() {
            return Ok(());
        }
        let deadline = tokio::time::timeout(timeout, async {
            loop {
                if rx.changed().await.is_err() {
                    // Sender dropped — the context is gone.
                    return Err(BrowserError::ShuttingDown);
                }
                if rx.borrow_and_update().agent_may_act() {
                    return Ok(());
                }
            }
        });
        match deadline.await {
            Ok(inner) => inner,
            Err(_) => Err(BrowserError::TakeoverWait {
                session: self.session.clone(),
            }),
        }
    }

    /// Apply the gate for `actor`: agents are checked, humans always pass.
    pub fn gate(&self, actor: Actor) -> Result<(), BrowserError> {
        match actor {
            Actor::Agent => self.ensure_agent(),
            Actor::Human => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resting_state_is_agent_driving() {
        let lock = DriveLock::new("alice");
        assert_eq!(lock.mode(), DriveMode::AgentDriving);
        assert!(lock.ensure_agent().is_ok());
    }

    #[test]
    fn takeover_refuses_the_agent_and_release_restores_it() {
        let lock = DriveLock::new("alice");
        let prev = lock.request_human_takeover();
        assert_eq!(prev, DriveMode::AgentDriving);
        assert_eq!(lock.mode(), DriveMode::HumanDriving);

        let err = lock.ensure_agent().expect_err("agent must be refused");
        match err {
            BrowserError::HumanDriving { session } => assert_eq!(session, "alice"),
            other => panic!("wrong error: {other:?}"),
        }

        let prev = lock.release_to_agent();
        assert_eq!(prev, DriveMode::HumanDriving);
        assert!(lock.ensure_agent().is_ok());
    }

    #[test]
    fn the_human_is_never_gated() {
        let lock = DriveLock::new("alice");
        lock.request_human_takeover();
        assert!(lock.gate(Actor::Human).is_ok());
        assert!(lock.gate(Actor::Agent).is_err());
    }

    #[test]
    fn takeover_and_release_are_idempotent() {
        let lock = DriveLock::new("bob");
        lock.request_human_takeover();
        assert_eq!(lock.request_human_takeover(), DriveMode::HumanDriving);
        assert_eq!(lock.mode(), DriveMode::HumanDriving);
        lock.release_to_agent();
        assert_eq!(lock.release_to_agent(), DriveMode::AgentDriving);
        assert_eq!(lock.mode(), DriveMode::AgentDriving);
    }

    #[tokio::test]
    async fn await_agent_returns_immediately_when_already_agent_driven() {
        let lock = DriveLock::new("bob");
        lock.await_agent(Duration::from_millis(50))
            .await
            .expect("no wait needed");
    }

    #[tokio::test]
    async fn await_agent_wakes_on_release() {
        let lock = std::sync::Arc::new(DriveLock::new("bob"));
        lock.request_human_takeover();
        let releaser = {
            let lock = lock.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                lock.release_to_agent();
            })
        };
        lock.await_agent(Duration::from_secs(2))
            .await
            .expect("should wake on release");
        releaser.await.unwrap();
        assert_eq!(lock.mode(), DriveMode::AgentDriving);
    }

    #[tokio::test]
    async fn await_agent_times_out_while_the_human_holds_it() {
        let lock = DriveLock::new("bob");
        lock.request_human_takeover();
        let err = lock
            .await_agent(Duration::from_millis(60))
            .await
            .expect_err("must time out");
        assert!(
            matches!(err, BrowserError::TakeoverWait { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn mode_serialises_for_the_ui() {
        let json = serde_json::to_string(&DriveMode::HumanDriving).unwrap();
        assert_eq!(json, "\"human_driving\"");
        assert_eq!(DriveMode::AgentDriving.to_string(), "AGENT_DRIVING");
    }
}
