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
  oklchHex,
  SILHOUETTES,
  SOLIDS,
  type AuthoredName,
  type Character,
  type EyeGeometry,
  type MarkPin,
  type MarkState,
  type MarkToken,
  type SilhouetteName,
  type Solid,
  type SolidName,
} from './character'
export { SessionMark, type SessionMarkProps } from './session-mark'
export { useOnScreen } from './use-on-screen'
