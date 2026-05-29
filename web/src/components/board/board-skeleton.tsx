/** Board loading skeleton: 5 columns of 3 cards. */
export function BoardSkeleton() {
  return (
    <div className="flex h-full gap-3 overflow-hidden">
      {Array.from({ length: 5 }).map((_, c) => (
        <div
          key={c}
          className="flex w-[280px] shrink-0 flex-col gap-2 rounded-xl border border-border bg-card/40 p-2"
        >
          <div className="h-5 w-24 rounded bg-muted/50" />
          {Array.from({ length: 3 }).map((_, r) => (
            <div
              key={r}
              className="flex flex-col gap-2 rounded-[10px] border border-border bg-background/60 p-3"
            >
              <div className="h-4 w-3/4 rounded bg-muted/50" />
              <div className="h-3 w-1/2 rounded bg-muted/40" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
