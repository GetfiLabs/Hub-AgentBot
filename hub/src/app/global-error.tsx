"use client";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#080a0f",
          color: "#edf3f8",
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          margin: 0,
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: "480px" }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 900, color: "#fff" }}>Critical Error</h1>
          <p style={{ marginTop: "0.75rem", color: "#8c98a7" }}>
            The application encountered an unexpected error.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: "0.5rem",
                fontFamily: "monospace",
                fontSize: "0.75rem",
                color: "#8c98a7",
              }}
            >
              {error.digest}
            </p>
          )}
          <button
            onClick={unstable_retry}
            style={{
              marginTop: "1.5rem",
              padding: "0.75rem 1.5rem",
              borderRadius: "8px",
              border: "1px solid rgba(61, 231, 255, 0.4)",
              background:
                "linear-gradient(135deg, rgba(61, 231, 255, 0.18), rgba(84, 240, 167, 0.14))",
              color: "#fff",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
