import { cn } from "@/shared/lib/cn";
import { Skeleton } from "@/shared/ui/skeleton";

type IdentityCardSkeletonProps = {
  className?: string;
  footerSubtitleWidthClass?: string;
  footerTitleWidthClass?: string;
  kind?: "single" | "stack";
  showAction?: boolean;
  stackCount?: number;
};

const MAX_STACK_ITEMS = 6;
const STACK_ITEM_KEYS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
];

export function IdentityCardSkeleton({
  className,
  footerSubtitleWidthClass = "w-16",
  footerTitleWidthClass = "w-28",
  kind = "single",
  showAction = false,
  stackCount = 3,
}: IdentityCardSkeletonProps) {
  return (
    <div
      className={cn(
        "relative aspect-[4/5] w-full min-w-0 overflow-hidden rounded-xl border border-border/70 bg-muted/50 shadow-xs",
        className,
      )}
    >
      {showAction ? (
        <Skeleton className="absolute top-3 right-3 z-30 h-7 w-7 rounded-md bg-background/70" />
      ) : null}

      {kind === "stack" ? (
        <StackSkeleton count={stackCount} />
      ) : (
        <SingleAvatarSkeleton />
      )}

      <div className="absolute right-3 bottom-3 left-3 z-30 flex min-w-0 flex-col gap-1 text-left">
        <Skeleton className={cn("h-4 max-w-full", footerTitleWidthClass)} />
        <Skeleton className={cn("h-4 max-w-full", footerSubtitleWidthClass)} />
      </div>
    </div>
  );
}

function SingleAvatarSkeleton() {
  return (
    <div className="absolute inset-x-0 top-0 bottom-12 flex items-center justify-center">
      <Skeleton className="h-[152px] w-[152px] rounded-full" />
    </div>
  );
}

function StackSkeleton({ count }: { count: number }) {
  const visibleCount = Math.max(1, Math.min(count, MAX_STACK_ITEMS));
  const { overlap, size } = getStackMetrics(visibleCount);

  return (
    <div className="absolute inset-x-0 top-0 bottom-12 flex items-center justify-center">
      <div className="flex max-w-full items-center justify-center px-2">
        {STACK_ITEM_KEYS.slice(0, visibleCount).map((key, index) => (
          <Skeleton
            className="rounded-full border-[3px] border-background"
            key={key}
            style={{
              height: size,
              marginLeft: index > 0 ? -overlap : 0,
              width: size,
              zIndex: index + 1,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function getStackMetrics(count: number) {
  switch (count) {
    case 1:
      return { overlap: 0, size: 152 };
    case 2:
      return { overlap: 44, size: 124 };
    case 3:
      return { overlap: 46, size: 108 };
    case 4:
      return { overlap: 50, size: 96 };
    case 5:
      return { overlap: 48, size: 86 };
    default:
      return { overlap: 46, size: 78 };
  }
}
