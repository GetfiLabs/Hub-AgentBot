export default function WalletLoading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="mb-6">
        <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-10 w-56 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-2 h-5 w-80 animate-pulse rounded bg-white/10" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="panel p-6">
          <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
          <div className="mt-2 h-5 w-full animate-pulse rounded bg-white/10" />
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="hairline rounded-lg p-4">
                <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
                <div className="mt-2 h-9 w-24 animate-pulse rounded-lg bg-white/10" />
              </div>
            ))}
          </div>
        </div>
        <div className="panel p-6">
          <div className="h-8 w-8 animate-pulse rounded bg-white/10" />
          <div className="mt-4 h-6 w-28 animate-pulse rounded bg-white/10" />
          <div className="mt-2 h-16 w-full animate-pulse rounded bg-white/10" />
        </div>
      </div>
      <div className="panel mt-4 p-5">
        <div className="h-6 w-24 animate-pulse rounded bg-white/10" />
        <div className="mt-5 space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-white/10" />
          ))}
        </div>
      </div>
    </div>
  );
}
