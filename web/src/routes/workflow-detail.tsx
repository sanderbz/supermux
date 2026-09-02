// The `/workflows/:id` route — what this workflow is, and what it has done.
//
// Two tabs, because they answer two different questions: "Steps" is the thing
// as configured (read-only — editing is the composer's job, one tap away), and
// "Runs" is the thing as it actually behaved. The header carries the controls a
// person reaches for from here: pause, run now, stop, edit.

import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Play, Square } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { SessionFace } from '@/components/roster/session-face'
import { parseCompletion, parseConnectors, parseFiles } from '@/lib/api/workflows'
import {
  useCancelRun,
  useRunWorkflow,
  useWorkflow,
  useWorkflowProgress,
  useWorkflowRuns,
  useWorkflowsStream,
} from '@/hooks/use-workflows'
import { EnableToggle } from '@/components/workflows/enable-toggle'
import { RunTimeline } from '@/components/workflows/run-timeline'
import { StepRail, railStatusFor } from '@/components/workflows/step-rail'
import { workflowHintParts } from '@/components/workflows/cadence'
import { completionSentence } from '@/components/workflows/completion-action-row'
import {
  WORKFLOWS_ROUTE,
  botThreadHref,
  workflowEditHref,
} from '@/components/workflows/workflow-href'

type Tab = 'steps' | 'runs'

export function WorkflowDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [tab, setTab] = React.useState<Tab>('runs')

  useWorkflowsStream()
  const progress = useWorkflowProgress()
  const detail = useWorkflow(id ?? null)
  const runs = useWorkflowRuns(id ?? null)
  const run = useRunWorkflow()
  const cancel = useCancelRun()

  if (detail.isLoading) {
    return <Centered>Loading…</Centered>
  }
  if (!detail.data) {
    return (
      <Centered>
        <p>That workflow isn’t here anymore.</p>
        <Link to={WORKFLOWS_ROUTE} className="mt-2 text-primary hover:underline">
          Back to workflows
        </Link>
      </Centered>
    )
  }

  const w = detail.data.workflow
  const steps = detail.data.steps ?? []
  const hint = workflowHintParts({ ...w, steps })
  const live = progress[w.id]
  const running = live?.running ?? false
  const action = parseCompletion(w.on_complete)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The shell's MobileTopBar renders nothing, so this route header owns its
          own top inset: reserve the iOS-PWA status-bar band on top so the title
          and controls clear the notch. `max()` no-ops at env=0 (desktop, browser
          tab), keeping the original 0.5rem; `pb-2` holds the bottom padding. */}
      <div className="sm-page-header sticky top-0 flex items-center gap-2 border-b border-border bg-background/85 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur sm:px-5">
        <Link
          to={WORKFLOWS_ROUTE}
          aria-label="Back to workflows"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
          {w.title}
        </span>
        <EnableToggle
          id={w.id}
          enabled={w.enabled === 1}
          title={w.title}
          onError={(m) => toast({ message: m, tone: 'error' })}
        />
        <Link
          to={workflowEditHref(w.id)}
          aria-label="Edit this workflow"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="size-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="mx-auto flex w-full max-w-[720px] min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-10 pt-3 sm:px-5">
        <section className="rounded-xl border border-border bg-card px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <SessionFace name={w.session} size={22} animate={false} />
            <Link
              to={botThreadHref(w.session)}
              className="text-[13px] font-medium text-foreground hover:underline"
            >
              {w.session}
            </Link>
            <span className="ml-auto text-[12px] text-muted-foreground">
              ran {w.run_count} time{w.run_count === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <StepRail
              steps={steps.length}
              current={live?.step ?? 0}
              status={railStatusFor(live?.status ?? null, running)}
            />
            <span className="text-[12px] text-muted-foreground">{hint.steps}</span>
          </div>
          <p className="mt-2.5 text-[14px] font-medium text-foreground">{hint.human}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {running ? 'Running now' : `Next ${hint.next}`}
            {' · '}
            {`ran ${hint.last}`}
          </p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            {completionSentence(action, w.session)}
          </p>
          <div className="mt-2.5 flex gap-2">
            {running ? (
              <button
                type="button"
                onClick={() =>
                  cancel.mutate(w.id, {
                    onSuccess: () => toast({ message: `Stopped “${w.title}”.` }),
                    onError: (e) =>
                      toast({ message: `Couldn’t stop — ${(e as Error).message}`, tone: 'error' }),
                  })
                }
                className="inline-flex h-11 items-center gap-1.5 rounded-full bg-secondary px-4 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Square className="size-3.5" aria-hidden="true" />
                Stop this run
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  run.mutate(w.id, {
                    onSuccess: () => toast({ message: `“${w.title}” started.` }),
                    onError: (e) =>
                      toast({ message: `Couldn’t start — ${(e as Error).message}`, tone: 'error' }),
                  })
                }
                className="inline-flex h-11 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Play className="size-3.5" aria-hidden="true" />
                Run now
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate(workflowEditHref(w.id))}
              className="inline-flex h-11 items-center rounded-full bg-secondary px-4 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Edit
            </button>
          </div>
        </section>

        <div role="tablist" aria-label="Workflow detail" className="flex gap-5 border-b border-border">
          {(['runs', 'steps'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'relative -mb-px h-9 text-[13.5px] font-semibold transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === t ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'runs' ? 'Runs' : 'Steps'}
              {tab === t && (
                <span
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>

        {tab === 'runs' ? (
          <RunTimeline
            runs={runs.data ?? []}
            steps={steps}
            session={w.session}
            onComplete={action}
            loading={runs.isLoading}
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((s, i) => {
              const files = parseFiles(s.files)
              const connectors = parseConnectors(s.connectors)
              return (
                <li key={s.id} className="rounded-xl border border-border bg-card px-3 py-2.5">
                  <p className="text-[13px] text-foreground">
                    <span className="tabular-nums text-muted-foreground">{i + 1}. </span>
                    {s.title || `Step ${i + 1}`}
                  </p>
                  {(s.command || s.prompt) && (
                    <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-snug text-muted-foreground">
                      {[s.command, s.prompt].filter(Boolean).join(' ')}
                    </p>
                  )}
                  {(files.length > 0 || connectors.length > 0) && (
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      {files.length > 0 && `${files.length} file${files.length === 1 ? '' : 's'}`}
                      {files.length > 0 && connectors.length > 0 && ' · '}
                      {connectors.join(', ')}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  )
}

export default WorkflowDetail
