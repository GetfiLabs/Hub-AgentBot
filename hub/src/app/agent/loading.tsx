export default function AgentLoading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="panel p-6 md:p-8">
        <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-10 w-72 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-6 space-y-3">
          <div className="h-10 animate-pulse rounded bg-white/10" />
          <div className="h-10 animate-pulse rounded bg-white/10" />
          <div className="h-10 animate-pulse rounded bg-white/10" />
        </div>
      </div>
    </div>
  );
}
