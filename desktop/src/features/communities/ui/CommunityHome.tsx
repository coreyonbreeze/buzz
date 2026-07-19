import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  Link2,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import * as React from "react";

import { ThemeGrainientBackground } from "@/app/ThemeGrainientBackground";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { requestOpenCreateAgent } from "@/features/agents/openCreateAgentEvent";
import { RequestedAgentCreateDialogs } from "@/features/agents/ui/RequestedAgentCreateDialogs";
import type { Community } from "@/features/communities/types";
import { useCommunityIcons } from "@/features/communities/useCommunityIcons";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ManagedAgent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

const CREATE_COMMUNITY_URL = "https://app.builderlab.xyz/signup?returnTo=/buzz";

// Pointy-top hexagon: flat vertical sides (so hexes in a column touch along
// their edges) and points at top/bottom (so alternating rows nest together).
const HEX_CLIP_PATH =
  "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)";

// Pointy-top geometry. Width W is the flat-to-flat measure; height = W / ASPECT.
// Neighboring cells sit exactly ASPECT·W apart vertically and W apart
// horizontally, so the lattice interlocks with no gaps at any scale.
const HEX_ASPECT = 0.866; // width / height = √3 / 2
const HALF_HEIGHT_UNITS = 0.5 / HEX_ASPECT; // half hex height when W = 1

const MIN_HEX_WIDTH = 96;
const MAX_HEX_WIDTH = 172;
const MAX_RADIUS = 4;

// Axial neighbor directions for a pointy-top hex, walked in order to trace a
// ring. Index 4 ([-1, 1]) is the ring's start offset from center.
const AXIAL_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Total cells in a filled hexagon of the given ring radius. */
function spiralCount(radius: number): number {
  return 1 + 3 * radius * (radius + 1);
}

/** Axial coordinates from the center outward, ring by ring, in spiral order. */
function hexSpiral(radius: number): [number, number][] {
  const cells: [number, number][] = [[0, 0]];
  for (let ring = 1; ring <= radius; ring++) {
    // Start one ring out along direction 4, then walk each of the 6 edges.
    let q = -ring;
    let r = ring;
    for (let side = 0; side < 6; side++) {
      const [dq, dr] = AXIAL_DIRECTIONS[side];
      for (let step = 0; step < ring; step++) {
        cells.push([q, r]);
        q += dq;
        r += dr;
      }
    }
  }
  return cells;
}

/** Axial (q, r) → unit-space center (before scaling by hex width W). */
function axialToUnitCenter(q: number, r: number): { cx: number; cy: number } {
  return { cx: q + r / 2, cy: HEX_ASPECT * r };
}

type PlacedCell = {
  q: number;
  r: number;
  cx: number;
  cy: number;
};

type LatticeExtent = {
  cells: PlacedCell[];
  minLeft: number;
  minTop: number;
  unitWidth: number;
  unitHeight: number;
};

/** Precompute cell centers + the unit bounding box for a given radius. */
function computeExtent(radius: number): LatticeExtent {
  const raw = hexSpiral(radius);
  const cells: PlacedCell[] = raw.map(([q, r]) => {
    const { cx, cy } = axialToUnitCenter(q, r);
    return { q, r, cx, cy };
  });
  let minLeft = Infinity;
  let maxRight = -Infinity;
  let minTop = Infinity;
  let maxBottom = -Infinity;
  for (const cell of cells) {
    minLeft = Math.min(minLeft, cell.cx - 0.5);
    maxRight = Math.max(maxRight, cell.cx + 0.5);
    minTop = Math.min(minTop, cell.cy - HALF_HEIGHT_UNITS);
    maxBottom = Math.max(maxBottom, cell.cy + HALF_HEIGHT_UNITS);
  }
  return {
    cells,
    minLeft,
    minTop,
    unitWidth: maxRight - minLeft,
    unitHeight: maxBottom - minTop,
  };
}

/** ResizeObserver-backed width + height for fit-to-container scaling. */
function useElementSize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = React.useRef<T>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

/** Shared hex frame: a hairline edge behind a clipped, filled interior. */
function HexFrame({
  children,
  edgeClassName,
  fillClassName,
}: {
  children: React.ReactNode;
  edgeClassName: string;
  fillClassName: string;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn("absolute inset-0", edgeClassName)}
        style={{ clipPath: HEX_CLIP_PATH }}
      />
      <span
        className={cn(
          "absolute inset-[1.5px] flex flex-col items-center justify-center overflow-hidden px-[12%] text-center",
          fillClassName,
        )}
        style={{ clipPath: HEX_CLIP_PATH }}
      >
        {children}
      </span>
    </>
  );
}

/** The central "you" cell — always present, works with no relay/profile. */
function ProfileHex({
  displayName,
  avatarUrl,
  onOpenSettings,
}: {
  displayName: string;
  avatarUrl: string | null;
  onOpenSettings: () => void;
}) {
  return (
    <button
      aria-label="Your profile and identity settings"
      className="group absolute inset-0 outline-hidden drop-shadow-[0_10px_24px_rgba(15,18,25,0.22)] transition-transform duration-300 ease-out hover:-translate-y-1 focus-visible:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      data-testid="community-home-profile"
      onClick={onOpenSettings}
      type="button"
    >
      <HexFrame
        edgeClassName="bg-primary/60 transition-colors duration-300 ease-out group-hover:bg-primary group-focus-visible:bg-primary"
        fillClassName="bg-card text-card-foreground"
      >
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,hsl(var(--primary)/0.2),transparent_66%)]" />
        <span className="relative flex aspect-square w-[36%] items-center justify-center transition-transform duration-300 ease-out group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
          <UserAvatar
            accent
            avatarUrl={avatarUrl}
            className="h-full w-full text-base ring-2 ring-primary/40"
            displayName={displayName}
            size="md"
            testId="community-home-profile-avatar"
          />
        </span>
        <span className="relative mt-2 max-w-full truncate text-sm font-semibold">
          {displayName}
        </span>
        <span className="relative mt-0.5 text-2xs font-medium uppercase tracking-[0.18em] text-primary/80">
          You
        </span>
      </HexFrame>
    </button>
  );
}

/** A saved community / relay you belong to. */
function CommunityHex({
  community,
  iconUrl,
  onOpen,
  onRemove,
}: {
  community: Community;
  iconUrl: string | null;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <button
          aria-label={`Open ${community.name}`}
          className="group absolute inset-0 outline-hidden drop-shadow-[0_8px_16px_rgba(15,18,25,0.16)] transition-transform duration-300 ease-out hover:-translate-y-1.5 focus-visible:-translate-y-1.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          data-testid={`community-home-community-${community.id}`}
          onClick={onOpen}
          type="button"
        >
          <HexFrame
            edgeClassName="bg-foreground/25 transition-colors duration-300 ease-out group-hover:bg-primary/70 group-focus-visible:bg-primary/80"
            fillClassName="bg-card text-card-foreground transition-colors duration-300 ease-out"
          >
            <span className="absolute inset-0 bg-[radial-gradient(circle_at_38%_20%,hsl(var(--primary)/0.12),transparent_62%)]" />
            <span className="relative flex aspect-square w-[34%] items-center justify-center overflow-hidden rounded-[28%] bg-primary/15 text-lg font-semibold text-primary ring-1 ring-primary/20 transition-transform duration-300 ease-out group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
              {iconUrl ? (
                <img
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                  src={iconUrl}
                />
              ) : (
                (community.name.trim()[0] ?? "🐝").toUpperCase()
              )}
            </span>
            <span className="relative mt-2 max-w-full truncate text-sm font-semibold">
              {community.name}
            </span>
            <span className="relative mt-1 flex items-center gap-1 text-2xs font-medium text-muted-foreground opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100">
              Enter <ArrowRight className="h-3 w-3" />
            </span>
          </HexFrame>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <ArrowRight className="h-4 w-4" />
          Open community
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => void navigator.clipboard.writeText(community.relayUrl)}
        >
          <Link2 className="h-4 w-4" />
          Copy relay URL
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
          Remove from Buzz
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One of your local agents — a peer on the same board as communities. */
function AgentHex({ agent }: { agent: ManagedAgent }) {
  const isRunning = agent.status === "running";
  return (
    <div
      className="absolute inset-0 drop-shadow-[0_8px_16px_rgba(15,18,25,0.14)]"
      data-testid={`community-home-agent-${agent.pubkey}`}
    >
      <HexFrame
        edgeClassName="bg-foreground/20"
        fillClassName="bg-background/80 text-foreground backdrop-blur-xl"
      >
        <span className="relative flex aspect-square w-[32%] items-center justify-center">
          <UserAvatar
            avatarUrl={agent.avatarUrl}
            className="h-full w-full text-sm"
            displayName={agent.name}
          />
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background",
              isRunning ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
        </span>
        <span className="relative mt-2 max-w-full truncate text-sm font-semibold">
          {agent.name}
        </span>
        <span className="relative mt-0.5 text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Agent
        </span>
      </HexFrame>
    </div>
  );
}

/** A frontier "grow your space" action, revealed on hover. */
function CreateHex({
  detail,
  icon,
  label,
  onClick,
  revealed,
  testId,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  revealed: boolean;
  testId: string;
}) {
  return (
    <button
      className={cn(
        "group absolute inset-0 outline-hidden transition-[opacity,transform] duration-300 ease-out hover:-translate-y-1.5 focus-visible:-translate-y-1.5 motion-reduce:transition-opacity motion-reduce:hover:translate-y-0",
        // Hidden tiles are non-interactive so a click in the blank area can't
        // silently trigger a create action; focus re-enables them for keyboard.
        revealed
          ? "opacity-100"
          : "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100",
      )}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      <HexFrame
        edgeClassName="bg-primary/25 transition-colors duration-300 ease-out group-hover:bg-primary/60 group-focus-visible:bg-primary/70"
        fillClassName="border border-dashed border-primary/25 bg-background/60 text-foreground backdrop-blur-md transition-colors duration-300 ease-out group-hover:bg-primary/[0.07]"
      >
        <span className="flex aspect-square w-[30%] items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/30 transition-all duration-300 ease-out group-hover:scale-105 group-hover:bg-primary group-hover:text-primary-foreground motion-reduce:transition-none motion-reduce:group-hover:scale-100">
          {icon}
        </span>
        <span className="mt-2 text-sm font-semibold">{label}</span>
        <span className="mt-0.5 text-2xs font-medium text-muted-foreground">
          {detail}
        </span>
      </HexFrame>
    </button>
  );
}

/** A prefilled-but-empty lattice cell: only a faint outline, and only on hover.
 *  Makes the grid read as one connected honeycomb rather than floating hexes. */
function GhostHex({ revealed }: { revealed: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none",
        revealed ? "opacity-100" : "opacity-0",
      )}
    >
      <span
        className="absolute inset-[1.5px] bg-foreground/[0.06]"
        style={{ clipPath: HEX_CLIP_PATH }}
      />
      <span
        className="absolute inset-[3px] bg-background/40"
        style={{ clipPath: HEX_CLIP_PATH }}
      />
    </span>
  );
}

type CreateAction = {
  detail: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
};

export function CommunityHome({
  communities,
  onOpenCommunity,
  onJoinCommunity,
  onRemoveCommunity,
  onBackToMachineConfig,
}: {
  communities: Community[];
  onOpenCommunity: (id: string) => void;
  onJoinCommunity: () => void;
  onRemoveCommunity: (id: string) => void;
  onBackToMachineConfig: () => void;
}) {
  const iconsByCommunity = useCommunityIcons(communities);
  const identityQuery = useIdentityQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const agents = managedAgentsQuery.data ?? [];

  const [communityToRemove, setCommunityToRemove] =
    React.useState<Community | null>(null);
  const [areaActive, setAreaActive] = React.useState(false);
  const [gridRef, gridSize] = useElementSize<HTMLDivElement>();

  const profileName = identityQuery.data?.displayName?.trim() || "You";

  // Order of the create-frontier actions, filling the first empty cells.
  const createActions = React.useMemo<CreateAction[]>(
    () => [
      {
        detail: "Spin up a helper",
        icon: <Sparkles className="h-5 w-5" />,
        label: "New agent",
        onClick: () => requestOpenCreateAgent(),
        testId: "community-home-create-agent",
      },
      {
        detail: "Start something new",
        icon: <Plus className="h-6 w-6" />,
        label: "New community",
        onClick: () => void openUrl(CREATE_COMMUNITY_URL),
        testId: "community-home-create",
      },
      {
        detail: "Use a relay URL",
        icon: <Link2 className="h-5 w-5" />,
        label: "Connect community",
        onClick: onJoinCommunity,
        testId: "community-home-join",
      },
    ],
    [onJoinCommunity],
  );

  // How many cells must be filled: you + your communities + your agents.
  const filledCount = 1 + communities.length + agents.length;

  // Grow the lattice one ring past the filled cluster so there is always a
  // connected frontier to reveal. The required radius is never capped — every
  // profile/community/agent/create cell must have a slot, so nothing is ever
  // silently dropped. MAX_RADIUS only bounds the extra decorative ghost ring.
  const extent = React.useMemo(() => {
    let needRing = 0;
    while (spiralCount(needRing) < filledCount + createActions.length) {
      needRing++;
    }
    const radius = needRing < MAX_RADIUS ? needRing + 1 : needRing;
    return computeExtent(radius);
  }, [filledCount, createActions.length]);

  // Fit the whole lattice inside the measured area (width and height), then
  // clamp to a comfortable hex size.
  const hexWidth = React.useMemo(() => {
    if (gridSize.width === 0) return MIN_HEX_WIDTH;
    const byWidth = (gridSize.width * 0.94) / extent.unitWidth;
    const byHeight =
      gridSize.height > 0
        ? (gridSize.height * 0.94) / extent.unitHeight
        : byWidth;
    return Math.max(
      MIN_HEX_WIDTH,
      Math.min(MAX_HEX_WIDTH, Math.min(byWidth, byHeight)),
    );
  }, [gridSize.width, gridSize.height, extent]);

  const hexHeight = hexWidth / HEX_ASPECT;
  const boardWidth = extent.unitWidth * hexWidth;
  const boardHeight = extent.unitHeight * hexWidth;

  // Assign each spiral cell a role: center = profile, then communities, then
  // agents, then the create actions, then decorative ghost cells.
  const rendered = extent.cells.map((cell, index) => {
    const left = (cell.cx - 0.5 - extent.minLeft) * hexWidth;
    const top = (cell.cy - HALF_HEIGHT_UNITS - extent.minTop) * hexWidth;
    const style: React.CSSProperties = {
      left,
      top,
      width: hexWidth,
      height: hexHeight,
    };
    const key = `${cell.q},${cell.r}`;

    if (index === 0) {
      return (
        <div className="absolute" key={key} style={style}>
          <ProfileHex
            avatarUrl={null}
            displayName={profileName}
            onOpenSettings={onBackToMachineConfig}
          />
        </div>
      );
    }

    const communityIndex = index - 1;
    if (communityIndex < communities.length) {
      const community = communities[communityIndex];
      return (
        <div className="absolute" key={community.id} style={style}>
          <CommunityHex
            community={community}
            iconUrl={iconsByCommunity[community.id] ?? null}
            onOpen={() => onOpenCommunity(community.id)}
            onRemove={() => setCommunityToRemove(community)}
          />
        </div>
      );
    }

    const agentIndex = communityIndex - communities.length;
    if (agentIndex < agents.length) {
      const agent = agents[agentIndex];
      return (
        <div className="absolute" key={agent.pubkey} style={style}>
          <AgentHex agent={agent} />
        </div>
      );
    }

    const createIndex = agentIndex - agents.length;
    if (createIndex < createActions.length) {
      const action = createActions[createIndex];
      return (
        <div className="absolute" key={action.testId} style={style}>
          <CreateHex
            detail={action.detail}
            icon={action.icon}
            label={action.label}
            onClick={action.onClick}
            revealed={areaActive}
            testId={action.testId}
          />
        </div>
      );
    }

    return (
      <div className="absolute" key={key} style={style}>
        <GhostHex revealed={areaActive} />
      </div>
    );
  });

  return (
    <main
      className="relative min-h-dvh overflow-hidden bg-background text-foreground"
      data-testid="community-home"
    >
      <StartupWindowDragRegion />
      <ThemeGrainientBackground />

      <Button
        aria-label="Identity settings"
        className="absolute right-6 top-6 z-10 rounded-full bg-background/50 backdrop-blur-md"
        onClick={onBackToMachineConfig}
        size="icon"
        type="button"
        variant="outline"
      >
        <Settings2 className="h-4 w-4" />
      </Button>

      <h1 className="sr-only">Your Buzz space</h1>

      <section
        aria-label="Your Buzz space"
        className="relative flex min-h-dvh w-full items-center justify-center px-8 py-16"
        onFocus={() => setAreaActive(true)}
        onPointerEnter={() => setAreaActive(true)}
        onPointerLeave={() => setAreaActive(false)}
        ref={gridRef}
      >
        {gridSize.width > 0 ? (
          <div
            className="relative"
            style={{ height: boardHeight, width: boardWidth }}
          >
            {rendered}
          </div>
        ) : null}

        {/* A quiet, one-time nudge toward the hidden frontier — fades away the
            moment you start exploring the grid. */}
        <p
          className={cn(
            "pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 text-center text-2xs font-medium uppercase tracking-[0.22em] text-muted-foreground transition-opacity duration-300 ease-out",
            areaActive ? "opacity-0" : "opacity-70",
          )}
        >
          Hover to build your space
        </p>
      </section>

      {/* The in-app create-agent flow normally lives in the connected shell;
          mount it here so "New agent" works before any relay is connected. */}
      <RequestedAgentCreateDialogs />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setCommunityToRemove(null);
        }}
        open={communityToRemove !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {communityToRemove?.name ?? "community"} from Buzz?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved community from this device. It does not
              delete the community or your membership.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                onClick={() => {
                  if (communityToRemove) {
                    onRemoveCommunity(communityToRemove.id);
                  }
                  setCommunityToRemove(null);
                }}
                type="button"
                variant="destructive"
              >
                Remove community
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
