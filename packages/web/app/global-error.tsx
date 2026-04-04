"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body
        style={{
          margin: 0,
          backgroundColor: "#0A0A0A",
          color: "#F3F4F6",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100dvh",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 500, margin: "0 0 8px" }}>
            Something went wrong
          </p>
          <p style={{ fontSize: 14, color: "#9CA3AF", margin: "0 0 24px" }}>
            Try reloading to get back on track
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: "12px 24px",
              borderRadius: 8,
              border: "none",
              backgroundColor: "#8C4A52",
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            Reload app
          </button>
        </div>
      </body>
    </html>
  );
}
