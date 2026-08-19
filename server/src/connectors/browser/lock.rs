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

use std::sync::atomic::{AtomicU8, Ordering};
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

/// **How** the wheel came back to the agent.
///
/// The mode alone cannot answer the only question a parked agent actually cares
/// about — *did the human finish?* Releasing the lock is unconditional (a human
/// who is gone must never wedge the context), so the same `AgentDriving` state
/// is reached by a deliberate hand-back and by a phone that lost signal
/// mid-login. Reporting both as "the human finished" is a lie the agent then
/// acts on, on a half-filled form. This enum is that missing bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandOff {
    /// The human pressed **Hand back** — an explicit control frame. The only
    /// value that may be reported to the agent as a completed hand-off.
    Explicit,
    /// The takeover socket went away WITHOUT a hand-back frame: a clean close, a
    /// tab close, a ping timeout, a network flap, a send error. The human is
    /// gone; whether they finished is unknown and must be reported as unknown.
    Disconnected,
    /// Nobody ever took the wheel (or nobody was attached when the agent's park
    /// budget expired) and the service handed it back rather than leaving the
    /// context wedged under a human who never arrived.
    Abandoned,
}

impl HandOff {
    /// Was this a deliberate "I'm done, carry on" from the human?
    pub fn is_explicit(self) -> bool {
        matches!(self, HandOff::Explicit)
    }

    fn as_u8(self) -> u8 {
        match self {
            HandOff::Explicit => 1,
            HandOff::Disconnected => 2,
            HandOff::Abandoned => 3,
        }
    }

    fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(HandOff::Explicit),
            2 => Some(HandOff::Disconnected),
            3 => Some(HandOff::Abandoned),
            _ => None,
        }
    }
}

/// `handoff` while a takeover is live / has never happened.
const HANDOFF_PENDING: u8 = 0;

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
    /// How the LAST takeover ended ([`HandOff`], or `HANDOFF_PENDING` while one
    /// is live / before the first). Separate from the watch value on purpose:
    /// the mode is the interlock every hot path reads, the provenance is only
    /// read by whoever is reporting the hand-off to the agent.
    handoff: AtomicU8,
}

impl DriveLock {
    /// A fresh lock, resting in [`DriveMode::AgentDriving`].
    pub fn new(session: impl Into<String>) -> Self {
        let (tx, _rx) = watch::channel(DriveMode::AgentDriving);
        Self {
            session: session.into(),
            tx,
            handoff: AtomicU8::new(HANDOFF_PENDING),
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
        // A new takeover invalidates the previous one's provenance: without this
        // reset a stale `Explicit` from the last round would be read as "this
        // human finished" by whoever parks on THIS one.
        self.handoff.store(HANDOFF_PENDING, Ordering::Release);
        // `send_replace` fires watchers even when the value is unchanged only
        // if it differs; either way the stored value ends up HumanDriving.
        self.tx.send_replace(DriveMode::HumanDriving);
        previous
    }

    /// **The wheel goes back to the agent**, recording *how* — see [`HandOff`].
    /// Returns the mode it replaced. Idempotent.
    ///
    /// The provenance is recorded only when this call is the one that actually
    /// took the wheel back (previous mode `HumanDriving`). That is what makes
    /// the takeover socket's unconditional teardown release safe to call after
    /// an explicit hand-back frame already landed: the redundant
    /// `Disconnected` release cannot overwrite the truthful `Explicit`.
    pub fn release_to_agent(&self, handoff: HandOff) -> DriveMode {
        let previous = self.mode();
        if previous == DriveMode::HumanDriving {
            self.handoff.store(handoff.as_u8(), Ordering::Release);
        }
        self.tx.send_replace(DriveMode::AgentDriving);
        previous
    }

    /// How the last takeover ended, or `None` if one is live / never happened.
    pub fn last_handoff(&self) -> Option<HandOff> {
        HandOff::from_u8(self.handoff.load(Ordering::Acquire))
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

        let prev = lock.release_to_agent(HandOff::Explicit);
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
        lock.release_to_agent(HandOff::Explicit);
        assert_eq!(
            lock.release_to_agent(HandOff::Explicit),
            DriveMode::AgentDriving
        );
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
                lock.release_to_agent(HandOff::Explicit);
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

    // ── hand-off provenance (FINDING 2) ─────────────────────────────────────

    #[test]
    fn an_explicit_hand_back_and_a_dropped_socket_are_distinguishable() {
        let lock = DriveLock::new("alice");
        assert_eq!(lock.last_handoff(), None, "no takeover has happened yet");

        lock.request_human_takeover();
        assert_eq!(lock.last_handoff(), None, "pending while the human drives");
        lock.release_to_agent(HandOff::Explicit);
        assert_eq!(lock.last_handoff(), Some(HandOff::Explicit));
        assert!(lock.last_handoff().unwrap().is_explicit());

        // The next takeover ends by the phone losing signal.
        lock.request_human_takeover();
        assert_eq!(
            lock.last_handoff(),
            None,
            "a new takeover must not inherit the previous hand-off"
        );
        lock.release_to_agent(HandOff::Disconnected);
        assert_eq!(lock.last_handoff(), Some(HandOff::Disconnected));
        assert!(!lock.last_handoff().unwrap().is_explicit());
    }

    /// The takeover socket releases UNCONDITIONALLY on teardown, and that
    /// teardown happens after an explicit `hand_back` frame too (the socket
    /// stays open, watching, until the tab closes). That second, redundant
    /// release must not rewrite the truthful `Explicit` into `Disconnected`.
    #[test]
    fn a_redundant_release_cannot_overwrite_the_truth() {
        let lock = DriveLock::new("alice");
        lock.request_human_takeover();
        lock.release_to_agent(HandOff::Explicit);
        // …later the socket drops; teardown releases again.
        lock.release_to_agent(HandOff::Disconnected);
        assert_eq!(
            lock.last_handoff(),
            Some(HandOff::Explicit),
            "the release that did NOT take the wheel back must not relabel it"
        );
    }

    #[test]
    fn nobody_came_is_its_own_reason() {
        let lock = DriveLock::new("alice");
        lock.request_human_takeover();
        lock.release_to_agent(HandOff::Abandoned);
        assert_eq!(lock.last_handoff(), Some(HandOff::Abandoned));
        assert!(!lock.last_handoff().unwrap().is_explicit());
    }

    #[test]
    fn mode_serialises_for_the_ui() {
        let json = serde_json::to_string(&DriveMode::HumanDriving).unwrap();
        assert_eq!(json, "\"human_driving\"");
        assert_eq!(DriveMode::AgentDriving.to_string(), "AGENT_DRIVING");
    }
}
