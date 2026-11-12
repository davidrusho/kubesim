import posthog from "posthog-js";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (!posthogKey || !posthogHost) {
  if (process.env.NODE_ENV === "development") {
    const missingVariable = posthogKey
      ? "NEXT_PUBLIC_POSTHOG_HOST"
      : "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN";

    // Warn rather than throw: an exception here stops the client from booting, so pages
    // such as the Incident player never get past their loading screen in `next dev`.
    console.warn(
      `${missingVariable} variable required by PostHog is missing or un-configured, so analytics are off. This warning stops appearing once ${missingVariable} is configured`,
    );
  }
} else {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    logs: {
      serviceName: "kubernetes-simulator-web",
      environment: process.env.NODE_ENV,
    },
    debug: process.env.NODE_ENV === "development",
  });
}
