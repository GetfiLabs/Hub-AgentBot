export default function EarnLoading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="panel mb-6 p-6 md:p-8">
        <div className="h-4 w-36 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-12 w-80 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-4 h-5 w-96 animate-pulse rounded bg-white/10" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="panel p-5">
            <div className="mb-7 flex items-start justify-between">
              <div>
                <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
                <div className="mt-1 h-7 w-24 animate-pulse rounded-lg bg-white/10" />
              </div>
              <div className="h-8 w-8 animate-pulse rounded bg-white/10" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="h-16 animate-pulse rounded-lg bg-white/10" />
              <div className="h-16 animate-pulse rounded-lg bg-white/10" />
            </div>
            <div className="mt-5 h-[42px] animate-pulse rounded-lg bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
