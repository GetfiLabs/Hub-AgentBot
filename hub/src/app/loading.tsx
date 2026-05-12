export default function Loading() {
  return (
    <div className="app-shell py-8 md:py-12">
      <div className="mb-6">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton mt-3 h-10 w-64 rounded-lg" />
        <div className="skeleton mt-2 h-5 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="panel p-5">
            <div className="skeleton h-4 w-20" />
            <div className="skeleton mt-3 h-8 w-28 rounded-lg" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="panel p-6">
          <div className="skeleton h-6 w-36" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-14 rounded-lg" />
            ))}
          </div>
        </div>
        <div className="panel p-6">
          <div className="skeleton h-6 w-36" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-14 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
