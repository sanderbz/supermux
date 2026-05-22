// Tailwind v4 runs through the @tailwindcss/vite plugin (see vite.config.ts), so
// no PostCSS plugins are needed here. This file is present for TECH_PLAN §2
// layout completeness and as the hook point for any future non-Tailwind PostCSS
// needs. Do NOT add @tailwindcss/postcss here — it would double-process CSS
// alongside the Vite plugin.
export default {
  plugins: {},
}
