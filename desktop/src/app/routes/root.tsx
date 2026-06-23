import { createRootRoute, useRouterState } from "@tanstack/react-router";

import { AppShell } from "@/app/AppShell";
import { AgentWindowRouteComponent } from "@/app/routes/agent-window";

/**
 * Popped-out agent conversation windows load the same frontend at
 * `/agent-window`. They must render without the full app shell (sidebar,
 * top chrome, notifications) — just a bare, OS-chromed surface that the
 * `/agent-window` route fills. Every other route renders the normal shell.
 */
function RootComponent() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  if (pathname.startsWith("/agent-window")) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <AgentWindowRouteComponent />
      </div>
    );
  }

  return <AppShell />;
}

export const Route = createRootRoute({
  component: RootComponent,
});
