/**
 * The session identity marks — the procedural character engine and its React
 * surface. Import from here; the internals (`./geometry`, `./ticker`) are an
 * implementation detail of how a character becomes pixels.
 */
export {
  accentInk,
  assignRoster,
  BLINK_CLOSING,
  blinkPeriod,
  bodyColor,
  characterFromSeed,
  EYE_INK,
  eyeClock,
  eyesFor,
  hash32,
  HUE_SLOTS,
  HUE_TRIM,
  isAuthored,
  isLive,
  mouthFor,
  mouthInk,
  oklchHex,
  SILHOUETTES,
  SOLIDS,
  type AuthoredName,
  type Character,
  type EyeGeometry,
  type MarkPin,
  type MarkState,
  type MarkToken,
  type MouthGeometry,
  type SilhouetteName,
  type Solid,
  type SolidName,
} from './character'
// The mark's viewBox half-extent. Exported because anything that has to seat
// something ON a silhouette (the roster row's attention dot) needs to convert
// the character's solid into box pixels; the rest of `./geometry` stays internal.
export { VIEWBOX } from './geometry'
export { SessionMark, type MarkAttention, type SessionMarkProps } from './session-mark'
export { useOnScreen } from './use-on-screen'
