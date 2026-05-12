export default function MyGamesLoading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
          <div className="mt-3 h-10 w-40 animate-pulse rounded-lg bg-white/10" />
          <div className="mt-2 h-5 w-72 animate-pulse rounded bg-white/10" />
        </div>
        <div className="h-[42px] w-32 animate-pulse rounded-lg bg-white/10" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="panel p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="h-6 w-28 animate-pulse rounded bg-white/10" />
                <div className="mt-2 h-3 w-36 animate-pulse rounded bg-white/10" />
              </div>
              <div className="h-6 w-16 animate-pulse rounded-md bg-white/10" />
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="hairline rounded-lg p-4">
                <div className="h-4 w-4 animate-pulse rounded bg-white/10" />
                <div className="mt-3 h-6 w-16 animate-pulse rounded bg-white/10" />
                <div className="mt-1 h-3 w-20 animate-pulse rounded bg-white/10" />
              </div>
              <div className="hairline rounded-lg p-4">
                <div className="h-4 w-4 animate-pulse rounded bg-white/10" />
                <div className="mt-3 h-6 w-16 animate-pulse rounded bg-white/10" />
                <div className="mt-1 h-3 w-20 animate-pulse rounded bg-white/10" />
              </div>
            </div>
            <div className="mt-3 h-20 animate-pulse rounded-lg bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
