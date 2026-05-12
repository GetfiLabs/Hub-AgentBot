export default function DashboardLoading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="mb-6">
        <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-10 w-72 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-2 h-5 w-56 animate-pulse rounded bg-white/10" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="panel p-5">
            <div className="flex items-center justify-between">
              <div className="h-4 w-20 animate-pulse rounded bg-white/10" />
              <div className="h-5 w-5 animate-pulse rounded bg-white/10" />
            </div>
            <div className="mt-3 h-9 w-24 animate-pulse rounded-lg bg-white/10" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="panel p-6">
            <div className="h-6 w-36 animate-pulse rounded bg-white/10" />
            <div className="mt-5 space-y-3">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="h-16 animate-pulse rounded-lg bg-white/10" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
