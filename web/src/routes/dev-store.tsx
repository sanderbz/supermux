// DEV bench (/dev/store) — the connector store + inline connect-card, offline.
//
// No server behind it: the grid renders from the curated fallback, grant state
// is seeded, and the ConnectCard renders against a seed card. Both themes and
// the [data-grok] skin on one page so the offline Playwright rig can screenshot
// the whole surface. Not a product route.
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StoreView } from '@/components/store/store-view'
import { ConnectorDetail } from '@/components/store/connector-detail'
import { CreateYourOwnSheet } from '@/components/store/create-your-own-sheet'
import { RegisterConnectorSheet } from '@/components/store/register-connector-sheet'
import { CURATED_FALLBACK } from '@/components/store/catalog'
import { ConnectCard } from '@/components/chat/ui/connect-card'
import { TakeoverCard } from '@/components/chat/ui/takeover-card'
import { EnableSigninSheet } from '@/components/store/enable-signin-sheet'
import type { ConnectorCard } from '@/lib/api/connectors'

const BENCH_QC = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})

const GRANTED = { bot: ['pmcp-github'], all: ['shared-browser'] }

// The library "Grant to" picker reads `GET /api/sessions`; offline we seed it so
// the choose-who-gets-it step renders with real-looking bots on the bench.
const MOCK_BOTS = [
  { name: 'Ada', status: 'active' },
  { name: 'Grace', status: 'idle' },
  { name: 'Linus', status: 'waiting' },
]

// P2b bench seeds — no live derive_auth offline, so stamp the auth lanes the
// server would set once an OAuth app is registered / for a hosted-OAuth card, so
// the rig can screenshot Lane A (device sign-in) + the ease pills.
const BENCH_CARDS: ConnectorCard[] = CURATED_FALLBACK.map((c) => {
  if (c.id === 'pmcp-github') {
    // GitHub with an app enabled → Lane A device sign-in + the "1-tap" pill.
    return {
      ...c,
      auth: { kind: 'oauth_device', device_url: 'https://github.com/login/device', scopes: ['repo', 'read:org'] },
    }
  }
  if (c.id === 'pmcp-notion') {
    // Hosted-OAuth (signs in in the bot terminal) → the "Easiest" pill + Lane D.
    return {
      ...c,
      auth: { kind: 'mcp_oauth', help_text: 'Notion signs in the first time your bot uses it — approve it in the bot’s terminal.' },
    }
  }
  if (c.id === 'pmcp-linear') {
    // Plain API-key lane (Linear PAT) — the "Connect" one-CTA reference case.
    return {
      ...c,
      auth: { kind: 'api_key', help_url: 'https://linear.app/settings/api', help_text: 'Create a personal API key in Linear settings.' },
    }
  }
  return c
})

// The three lanes the "One-CTA detail" bench renders (mcp_oauth / oauth_device /
// api_key) so the offline rig screenshots the consolidated single-primary detail.
const ONECTA_MCP: ConnectorCard = BENCH_CARDS.find((c) => c.id === 'pmcp-notion')!
const ONECTA_DEVICE: ConnectorCard = BENCH_CARDS.find((c) => c.id === 'pmcp-github')!
const ONECTA_KEY: ConnectorCard = BENCH_CARDS.find((c) => c.id === 'pmcp-linear')!

// Lane A device card (GitHub, app enabled) for the inline connect-card + a plain
// key card (iCloud) for the paste lane.
const OAUTH_CARD: ConnectorCard = BENCH_CARDS.find((c) => c.id === 'pmcp-github')!
const KEY_CARD: ConnectorCard = CURATED_FALLBACK.find((c) => c.id === 'icloud-mail')!

function Slab({
  theme,
  grok,
}: {
  theme: 'light' | 'dark'
  grok?: boolean
}) {
  return (
    <div
      data-theme={theme}
      className={theme === 'dark' ? 'dark bg-background text-foreground' : 'bg-background text-foreground'}
    >
      <div {...(grok ? { 'data-grok': '' } : {})} className="flex flex-col gap-10 px-4 py-10">
        <header className="mx-auto w-full max-w-[1120px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Connector store — {theme}
            {grok ? ' · grok' : ''}
          </h1>
        </header>

        {/* the full library grid */}
        <div
          data-vr={`store-grid-${theme}${grok ? '-grok' : ''}`}
          className="h-[720px] overflow-hidden rounded-3xl border border-border"
        >
          <StoreView grantTarget={null} mock={BENCH_CARDS} mockGranted={GRANTED} mockBots={MOCK_BOTS} detailTheme={theme} />
        </div>

        {/* bot-scoped variant (rows) */}
        <div
          data-vr={`store-sheet-${theme}${grok ? '-grok' : ''}`}
          className="mx-auto h-[560px] w-full max-w-[560px] overflow-hidden rounded-3xl border border-border"
        >
          <StoreView grantTarget="Ada" mock={BENCH_CARDS} mockGranted={GRANTED} variant="sheet" detailTheme={theme} />
        </div>

        {/* the inline connect-cards (chat surface — needs the sm token slab) */}
        <div className="mx-auto w-full max-w-[640px]">
          <h2 className="mb-3 text-sm font-medium text-foreground">Inline connect-card</h2>
          <div className="flex flex-col gap-6" data-vr={`connect-cards-${theme}${grok ? '-grok' : ''}`}>
            <ConnectCard
              request={{
                connector_id: OAUTH_CARD.id,
                display_name: OAUTH_CARD.display_name,
                tool_count: OAUTH_CARD.tool_count,
                has_oauth: true,
              }}
              sessionName="Ada"
              card={OAUTH_CARD}
            />
            <ConnectCard
              request={{
                connector_id: KEY_CARD.id,
                display_name: KEY_CARD.display_name,
                tool_count: KEY_CARD.tools.length,
                has_oauth: false,
              }}
              sessionName="Ada"
              card={KEY_CARD}
            />
          </div>
        </div>

        {/* the inline TAKE-THE-WHEEL card (the Shared Browser's human moment) */}
        <div className="mx-auto w-full max-w-[640px]">
          <h2 className="mb-3 text-sm font-medium text-foreground">Inline takeover card</h2>
          <div data-vr={`takeover-card-${theme}${grok ? '-grok' : ''}`}>
            <TakeoverCard
              ask={{
                session: 'Ada',
                reason: 'sign in to bank.example and approve the 2FA push on your phone',
              }}
              botName="Ada"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// The guided "Enable Sign-in with GitHub" registration wizard — mounted ONCE (one
// body-portal, so it never obscures the slab screenshots) and opened on demand.
// The rig captures it by loading `/dev/store#signin` (or tapping the trigger); the
// sheet uses only the register MUTATION (no auto-fetch), so it renders offline.
function RegistrationPreview() {
  const [open, setOpen] = React.useState(
    () => typeof window !== 'undefined' && window.location.hash === '#signin',
  )
  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 py-8">
      <h2 className="mb-3 text-sm font-medium text-foreground">Guided OAuth-app registration</h2>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-vr="open-enable-signin"
        className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-[14px] font-semibold text-foreground hover:bg-muted"
      >
        Preview: Enable Sign-in with GitHub
      </button>
      <EnableSigninSheet open={open} onOpenChange={setOpen} provider="github" companyId={null} companyName={null} />
    </div>
  )
}

// One-CTA detail bench — the consolidated connector detail mounted OPEN for the
// three lanes at 390px, so the rig can screenshot the single-primary CTA:
// mcp_oauth (one blue "Connect in a bot"), oauth_device (Lane A "Sign in with"),
// api_key (one blue "Connect"). ConnectorDetail calls useNavigate() for the
// handoff; /dev/store already provides the app Router, so no wrapper is needed —
// it useNavigate throws (no Router around /dev/store). Library scope
// (grantTarget=null) exercises the GrantPicker + handoff text-link paths.
function OneCtaBench({ theme }: { theme: 'light' | 'dark' }) {
  const cols: { id: string; vr: string; card: ConnectorCard }[] = [
    { id: 'onecta-mcp', vr: 'onecta-mcp', card: ONECTA_MCP },
    { id: 'onecta-device', vr: 'onecta-device', card: ONECTA_DEVICE },
    { id: 'onecta-key', vr: 'onecta-key', card: ONECTA_KEY },
  ]
  return (
    <div
      data-theme={theme}
      className={theme === 'dark' ? 'dark bg-background text-foreground' : 'bg-background text-foreground'}
    >
      <div className="flex flex-col gap-6 px-4 py-10">
        <header className="mx-auto w-full max-w-[1220px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            One-CTA detail (390px) — {theme}
          </h1>
        </header>
        {/* /dev/store already renders inside the app's Router, so ConnectorDetail's
            useNavigate() resolves — no (and never a NESTED) Router here. */}
        <div className="mx-auto flex w-full max-w-[1220px] flex-wrap items-start justify-center gap-6">
          {cols.map((col) => (
            <div
              key={col.id}
              data-vr={col.vr}
              className="w-full max-w-[390px] overflow-hidden rounded-3xl border border-border bg-background"
            >
              <ConnectorDetail
                card={col.card}
                installed={false}
                granted={null}
                grantTarget={null}
                botsOverride={MOCK_BOTS}
                onDone={() => {}}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// A seed manifest for the "Register connector" review card — the shape a bot
// authors + hands to the owner (secret-free: `${VAR}` placeholder + schema only).
const SEED_MANIFEST = JSON.stringify(
  {
    id: 'linear',
    kind: 'agent_authored',
    display_name: 'Linear',
    icon: '',
    description: 'Create and list Linear issues from your bots.',
    tools: [
      { name: 'create_issue', description: 'Create an issue' },
      { name: 'list_issues', description: 'List issues' },
    ],
    credentials: [
      { key: 'LINEAR_API_KEY', title: 'API key', type: 'string', sensitive: true, required: true },
    ],
    auth: { kind: 'api_key', help_url: 'https://linear.app/settings/api' },
    emit: { command: 'node', args: ['/opt/linear-mcp/server.js'], env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' } },
  },
  null,
  2,
)

// The two new "Create your own connector" sheets, mounted so the offline rig can
// screenshot them. They open on the trigger tap (or the URL hash), mirroring the
// RegistrationPreview pattern — the sheets body-portal, so a closed default keeps
// the slab screenshots clean.
function CreateConnectorBench() {
  const [createOpen, setCreateOpen] = React.useState(
    () => typeof window !== 'undefined' && window.location.hash === '#create',
  )
  const [registerOpen, setRegisterOpen] = React.useState(
    () => typeof window !== 'undefined' && window.location.hash === '#register',
  )
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3 px-4 py-8">
      <h2 className="text-sm font-medium text-foreground">Create your own connector</h2>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          data-vr="open-create-your-own"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-[14px] font-semibold text-foreground hover:bg-muted"
        >
          Preview: Create-your-own sheet
        </button>
        <button
          type="button"
          onClick={() => setRegisterOpen(true)}
          data-vr="open-register-connector"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-[14px] font-semibold text-foreground hover:bg-muted"
        >
          Preview: Register-connector sheet
        </button>
      </div>
      <CreateYourOwnSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialQuery="Linear"
        cards={BENCH_CARDS}
        botsOverride={MOCK_BOTS}
        onRegister={() => {
          setCreateOpen(false)
          setRegisterOpen(true)
        }}
      />
      <RegisterConnectorSheet open={registerOpen} onOpenChange={setRegisterOpen} initialManifest={SEED_MANIFEST} />
    </div>
  )
}

export default function DevStore() {
  return (
    <QueryClientProvider client={BENCH_QC}>
      <TooltipProvider delayDuration={200}>
        <ToastProvider>
          <div className="min-h-screen">
            <Slab theme="light" />
            <Slab theme="light" grok />
            <Slab theme="dark" />
            <Slab theme="dark" grok />
            <OneCtaBench theme="light" />
            <OneCtaBench theme="dark" />
            <CreateConnectorBench />
            <RegistrationPreview />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
