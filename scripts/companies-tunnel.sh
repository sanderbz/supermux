#!/usr/bin/env bash
#
# companies-tunnel.sh — provision a per-company Cloudflare tunnel + public hostname
# for supermux "companies" (P3d).
#
# Each company's external human colleagues reach exactly ONE host:
#
#     <slug>.<base_domain>   ->   the local supermux bind (default 127.0.0.1:8823)
#
# where <base_domain> is a Cloudflare zone YOUR token controls (passed via --zone).
# This is the manual/scriptable equivalent of the in-app guided Cloudflare wizard,
# which is the recommended path; this script is for operators who prefer the CLI.
#
# This script creates (or reuses) a named Cloudflare tunnel, adds the public
# hostname route <slug>.<base_domain> -> the local bind, and then PRINTS the two
# config fragments the operator must paste by hand:
#
#   1. the `[[company_hosts]]` block for supermux's config.toml, and
#   2. the Google OAuth "Authorized redirect URI" to register in the Google Cloud
#      console for this host.
#
# It is INERT until you give it a Cloudflare API token and a company. NO secret is
# hardcoded or fetched: the CF token comes from --cf-token / $CLOUDFLARE_API_TOKEN
# only, and nothing here touches the supermux admin bearer or the Google secret.
#
# This is a CODE + RECIPE deliverable, not live provisioning: the Cloudflare API
# token, the DNS zone (your --zone), and the Google OAuth app are YOUR own
# infrastructure. Review the printed config before restarting supermux.
#
# ── Usage ────────────────────────────────────────────────────────────────────────
#
#   scripts/companies-tunnel.sh \
#       --slug acme \
#       --company-id 7 \
#       --zone example.com \
#       [--bind 127.0.0.1:8823] \
#       [--tunnel-name supermux-acme] \
#       [--cf-token <token> | env CLOUDFLARE_API_TOKEN] \
#       [--print-only]     # skip all cloudflared calls; just print the config
#
# Requirements (for the provisioning path): `cloudflared` logged in to the account
# that owns the zone (`cloudflared tunnel login`). With --print-only you need
# neither cloudflared nor a token — handy to just emit the config fragments.
#
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────────
SLUG=""
COMPANY_ID=""
BIND="127.0.0.1:8823"
ZONE=""                  # the base domain (a Cloudflare zone your token controls); REQUIRED via --zone
TUNNEL_NAME=""
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
PRINT_ONLY=0

die() { echo "error: $*" >&2; exit 1; }

# ── args ─────────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)        SLUG="${2:?}"; shift 2;;
    --company-id)  COMPANY_ID="${2:?}"; shift 2;;
    --bind)        BIND="${2:?}"; shift 2;;
    --zone)        ZONE="${2:?}"; shift 2;;
    --tunnel-name) TUNNEL_NAME="${2:?}"; shift 2;;
    --cf-token)    CF_TOKEN="${2:?}"; shift 2;;
    --print-only)  PRINT_ONLY=1; shift;;
    -h|--help)     sed -n '2,43p' "$0"; exit 0;;
    *)             die "unknown argument: $1";;
  esac
done

[ -n "$ZONE" ]       || die "--zone is required (your base domain, a Cloudflare zone your token controls, e.g. example.com)"
[ -n "$SLUG" ]       || die "--slug is required (the company slug; host becomes <slug>.$ZONE)"
[ -n "$COMPANY_ID" ] || die "--company-id is required (the companies.id this host serves)"

# Validate the slug the same way the server does (companies::valid_slug): it becomes
# a DNS label and a URL segment, so no shell/host metacharacters.
case "$SLUG" in
  *[!a-zA-Z0-9._-]*) die "invalid slug '$SLUG' (allowed: letters, digits, '_', '.', '-')";;
esac
case "$COMPANY_ID" in
  ''|*[!0-9]*) die "--company-id must be a positive integer";;
esac

# ── canonical derivations (must match server/src/config.rs) ──────────────────────
HOST="${SLUG}.${ZONE}"
REDIRECT_URI="https://${HOST}/auth/callback"
SERVICE_URL="http://${BIND}"
[ -n "$TUNNEL_NAME" ] || TUNNEL_NAME="supermux-${SLUG}"

# ── provisioning (skipped with --print-only) ─────────────────────────────────────
if [ "$PRINT_ONLY" -eq 0 ]; then
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared not found (install it, or re-run with --print-only)"

  # A token is only needed for the DNS-route step; cloudflared reads it from env.
  if [ -n "$CF_TOKEN" ]; then
    export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
  fi

  echo "==> ensuring named tunnel '$TUNNEL_NAME'"
  if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
    echo "    (tunnel already exists — reusing)"
  else
    cloudflared tunnel create "$TUNNEL_NAME"
  fi

  echo "==> routing public hostname $HOST -> this tunnel"
  # `tunnel route dns` needs the zone's DNS edit permission on the token/login.
  cloudflared tunnel route dns "$TUNNEL_NAME" "$HOST"

  echo "==> tunnel ready. Run the connector with an ingress rule, e.g.:"
  cat <<EOF

    # ~/.cloudflared/config.yml (ingress for $TUNNEL_NAME)
    tunnel: $TUNNEL_NAME
    ingress:
      - hostname: $HOST
        service: $SERVICE_URL
      - service: http_status:404      # deny everything else (no /api/calendar.ics leak, etc.)

    # then:  cloudflared tunnel run $TUNNEL_NAME
EOF
fi

# ── the config the operator must add ─────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────────────────────────
 Add to supermux config.toml  (data_dir/config.toml)  then restart supermux:
────────────────────────────────────────────────────────────────────────────────

[[company_hosts]]
host = "$HOST"
company_id = $COMPANY_ID
redirect_uri = "$REDIRECT_URI"

  • This host is auto-added to the WebSocket Origin allowlist (no extra_origins
    entry needed — the server consults company_hosts directly).
  • A cookie minted for a DIFFERENT company is rejected on this host.

────────────────────────────────────────────────────────────────────────────────
 Add to the Google Cloud OAuth 2.0 "Web application" client
 (APIs & Services → Credentials → your client → Authorized redirect URIs):
────────────────────────────────────────────────────────────────────────────────

    $REDIRECT_URI

  • One redirect URI per company host. Nothing else changes: the login flow is a
    server-side 302 + server-side token exchange, so no CSP change is needed.

────────────────────────────────────────────────────────────────────────────────
 Reminders (owner infra — NOT provisioned here):
────────────────────────────────────────────────────────────────────────────────
  • Keep the tunnel ingress allowlist tight: front the SPA + /api/* + /ws/* +
    /auth/* only, and DO NOT expose /api/calendar.ics (owner-only feed).
  • The Google client_secret + supermux admin bearer never travel over the tunnel.
EOF
