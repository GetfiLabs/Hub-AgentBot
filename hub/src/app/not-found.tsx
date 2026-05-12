import Link from "next/link";
import { SearchX } from "lucide-react";

export default function NotFound() {
  return (
    <div className="app-shell grid min-h-[62vh] place-items-center py-12 text-center">
      <div className="panel max-w-md p-8">
        <SearchX className="mx-auto h-12 w-12 text-[var(--amber)]" />
        <h1 className="mt-5 text-4xl font-black text-heading">404</h1>
        <h2 className="mt-2 text-xl font-black text-heading">Page not found</h2>
        <p className="mt-2 text-[var(--muted)]">The page you are looking for does not exist.</p>
        <Link href="/" className="command-button mt-6 inline-flex px-5">
          Go home
        </Link>
      </div>
    </div>
  );
}
