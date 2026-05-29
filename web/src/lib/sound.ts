// sound.ts — the "needs input" audio cue.
//
// A single, deliberately subtle one-shot tone that plays when a session
// transitions into `waiting` (the agent is blocked on you). One octave pitch
// slide (440 → 880 Hz) over 200ms, gentle 0.15 gain with an exponential ramp
// out — reads as a polite "your turn", not an alert.
//
// Politeness: OFF by default. The user opts in via Settings → Appearance
// (CONFIG `MISC.soundsToggleLabel`). The preference persists in localStorage so
// it survives reloads without needing the backend.
//
// Wiring for later milestones (SSE handler, settings):
//   - On a status delta into 'waiting', call `playNeedsInput()`. It self-gates
//     on the stored preference, so callers don't need to check first. The
//     `if (sounds) …` guard lives inside this module.
//   - Bind the Settings toggle to `getSoundsEnabled()` / `setSoundsEnabled()`.
//   - Call `primeAudio()` from the first real user gesture (a tap/click) so iOS
//     Safari unlocks the AudioContext; without a gesture, mobile stays silent.

import { SOUND } from '../brand/tokens'

const STORAGE_KEY = 'supermux.sounds.enabled'

type AudioCtor = typeof AudioContext
function audioCtor(): AudioCtor | undefined {
  if (typeof window === 'undefined') return undefined
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  )
}

let ctx: AudioContext | null = null
function getCtx(): AudioContext | null {
  const Ctor = audioCtor()
  if (!Ctor) return null
  if (!ctx) ctx = new Ctor()
  // Autoplay policy: contexts start suspended until a user gesture resumes them.
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** Whether the cue is enabled. Default OFF (opt-in). */
export function getSoundsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === '1'
}

/** Persist the toggle. Wire this to the Settings → Appearance switch. */
export function setSoundsEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
}

/**
 * Unlock audio on iOS/Safari. Call once from a genuine user gesture (the first
 * tap into focus mode is a good spot). Safe to call repeatedly.
 */
export function primeAudio(): void {
  getCtx()
}

/**
 * Play the cue regardless of the preference. Prefer `playNeedsInput()` for the
 * normal path; this exists for previews/tests and the Settings "test" button.
 */
export function playTone(): void {
  const ac = getCtx()
  if (!ac) return

  const now = ac.currentTime
  const { freqStart, freqEnd, gain, durationS } = SOUND

  const osc = ac.createOscillator()
  osc.type = 'sine' // gentle — no harsh harmonics
  osc.frequency.setValueAtTime(freqStart, now)
  osc.frequency.linearRampToValueAtTime(freqEnd, now + durationS)

  const amp = ac.createGain()
  // Quick attack, exponential decay (exponential ramps can't hit 0).
  amp.gain.setValueAtTime(0.0001, now)
  amp.gain.exponentialRampToValueAtTime(gain, now + 0.01)
  amp.gain.exponentialRampToValueAtTime(0.0001, now + durationS)

  osc.connect(amp).connect(ac.destination)
  osc.start(now)
  osc.stop(now + durationS + 0.02)
}

/**
 * The normal entry point. Plays the cue only when the user has opted in — the
 * SSE handler can call this on every transition into `waiting` without guarding.
 */
export function playNeedsInput(): void {
  if (!getSoundsEnabled()) return
  playTone()
}
