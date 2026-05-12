export default function ProfileLoading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="mb-6">
        <div className="h-4 w-20 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-10 w-32 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-2 h-5 w-64 animate-pulse rounded bg-white/10" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="panel p-6">
          <div className="flex items-center gap-4 border-b border-white/10 pb-6">
            <div className="h-16 w-16 animate-pulse rounded-full bg-white/10" />
            <div>
              <div className="h-7 w-40 animate-pulse rounded-lg bg-white/10" />
              <div className="mt-2 h-4 w-48 animate-pulse rounded bg-white/10" />
            </div>
          </div>
          <div className="mt-6 space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-white/10" />
            ))}
          </div>
        </div>
        <div className="panel p-6">
          <div className="h-6 w-40 animate-pulse rounded bg-white/10" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-white/10" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
