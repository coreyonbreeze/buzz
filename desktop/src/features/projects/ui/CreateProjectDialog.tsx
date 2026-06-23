import * as React from "react";
import { GitBranch, Lock, Unlock } from "lucide-react";

import { normalizeProjectSlug } from "@/features/projects/projectEvents.mjs";
import type { CreateProjectInput } from "@/features/projects/hooks";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";

const FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors duration-150 ease-out hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
const FIELD_CONTROL_CLASS =
  "border-0 bg-transparent text-muted-foreground/55 shadow-none outline-none ring-0 transition-colors duration-150 ease-out placeholder:text-muted-foreground/55 focus:bg-transparent focus:text-foreground focus:outline-hidden focus-visible:ring-0";

type CreateProjectDialogProps = {
  open: boolean;
  isCreating: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateProjectInput) => Promise<void>;
};

export function CreateProjectDialog({
  open,
  isCreating,
  onOpenChange,
  onCreate,
}: CreateProjectDialogProps) {
  const [name, setName] = React.useState("");
  const [repoId, setRepoId] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [defaultBranch, setDefaultBranch] = React.useState("main");
  const [isPrivate, setIsPrivate] = React.useState(false);
  const [repoIdTouched, setRepoIdTouched] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const nameInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setRepoId("");
    setDescription("");
    setDefaultBranch("main");
    setIsPrivate(false);
    setRepoIdTouched(false);
    setErrorMessage(null);

    const timerId = globalThis.setTimeout(() => {
      nameInputRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  function handleNameChange(value: string) {
    setName(value);
    if (!repoIdTouched) {
      setRepoId(normalizeProjectSlug(value));
    }
    setErrorMessage(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedRepoId = repoId.trim();
    if (!trimmedName || !trimmedRepoId) return;

    setErrorMessage(null);
    try {
      await onCreate({
        name: trimmedName,
        repoId: trimmedRepoId,
        description: description.trim() || undefined,
        visibility: isPrivate ? "private" : "open",
        defaultBranch: defaultBranch.trim() || "main",
      });
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create project.",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
    >
      <ChooserDialogContent
        className="max-w-lg"
        contentClassName="pt-3"
        data-testid="create-project-dialog"
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        title="Create project"
        description="Create a Buzz-hosted Git repo with a linked channel for project and code discussion."
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {isPrivate ? (
                <Lock className="h-4 w-4" />
              ) : (
                <Unlock className="h-4 w-4" />
              )}
              {isPrivate ? "Private channel" : "Open channel"}
            </div>
            <Button
              data-testid="create-project-submit"
              disabled={
                isCreating ||
                name.trim().length === 0 ||
                repoId.trim().length === 0
              }
              form="create-project-form"
              type="submit"
            >
              {isCreating ? "Creating..." : "Create project"}
            </Button>
          </div>
        }
      >
        <form
          className="space-y-5"
          id="create-project-form"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="create-project-name"
            >
              Name
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                FIELD_SHELL_CLASS,
              )}
            >
              <Input
                autoComplete="off"
                className={cn("h-8 px-0 py-0 leading-6", FIELD_CONTROL_CLASS)}
                data-testid="create-project-name"
                disabled={isCreating}
                id="create-project-name"
                onChange={(event) => handleNameChange(event.target.value)}
                placeholder="Mobile launch"
                ref={nameInputRef}
                value={name}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="create-project-repo"
            >
              Repository ID
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                FIELD_SHELL_CLASS,
              )}
            >
              <Input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                className={cn(
                  "h-8 px-0 py-0 font-mono leading-6",
                  FIELD_CONTROL_CLASS,
                )}
                data-testid="create-project-repo"
                disabled={isCreating}
                id="create-project-repo"
                onChange={(event) => {
                  setRepoIdTouched(true);
                  setRepoId(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder="mobile-launch"
                value={repoId}
              />
            </div>
            <p className="text-xs text-muted-foreground/70">
              Used in the Buzz Git clone URL.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="create-project-description"
            >
              Description
            </label>
            <Textarea
              className={cn(
                "min-h-24 resize-none px-3 py-2",
                FIELD_SHELL_CLASS,
              )}
              data-testid="create-project-description"
              disabled={isCreating}
              id="create-project-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What outcome should this project drive?"
              value={description}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1.5" htmlFor="create-project-branch">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                Default branch
              </span>
              <div
                className={cn(
                  "flex min-h-11 items-center px-3",
                  FIELD_SHELL_CLASS,
                )}
              >
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  className={cn(
                    "h-8 px-0 py-0 font-mono leading-6",
                    FIELD_CONTROL_CLASS,
                  )}
                  disabled={isCreating}
                  id="create-project-branch"
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  value={defaultBranch}
                />
              </div>
            </label>

            <div className="space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                Discussion access
              </span>
              <div className="flex min-h-11 items-center justify-between rounded-xl border border-input bg-muted/40 px-3">
                <span className="text-sm text-muted-foreground">
                  Private channel
                </span>
                <Switch
                  aria-label="Create a private project discussion channel"
                  checked={isPrivate}
                  disabled={isCreating}
                  onCheckedChange={setIsPrivate}
                />
              </div>
            </div>
          </div>

          {errorMessage ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
