import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";

type AgentDefinitionDialogFooterProps = {
  canSubmit: boolean;
  isAvatarUploadPending: boolean;
  isPending: boolean;
  onCancel: () => void;
  onPublishUpdatesCheckedChange: (checked: boolean) => void;
  publishUpdatesChecked: boolean;
  showPublishUpdates: boolean;
  submitBlockReason: string | null;
  submitLabel: string;
};

export function AgentDefinitionDialogFooter({
  canSubmit,
  isAvatarUploadPending,
  isPending,
  onCancel,
  onPublishUpdatesCheckedChange,
  publishUpdatesChecked,
  showPublishUpdates,
  submitBlockReason,
  submitLabel,
}: AgentDefinitionDialogFooterProps) {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-3">
        {submitBlockReason ? (
          <p
            className="text-2xs text-muted-foreground"
            data-testid="persona-dialog-submit-reason"
          >
            {submitBlockReason}
          </p>
        ) : null}
        {showPublishUpdates ? (
          <label
            className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground"
            htmlFor="persona-dialog-publish-updates"
          >
            <Checkbox
              checked={publishUpdatesChecked}
              data-testid="persona-dialog-publish-updates"
              disabled={isPending || isAvatarUploadPending}
              id="persona-dialog-publish-updates"
              onCheckedChange={(checked) =>
                onPublishUpdatesCheckedChange(checked === true)
              }
            />
            <span>Publish updates</span>
          </label>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          disabled={isPending || isAvatarUploadPending}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          data-testid="persona-dialog-submit"
          disabled={!canSubmit}
          form="persona-dialog-form"
          type="submit"
        >
          {isPending
            ? "Saving..."
            : isAvatarUploadPending
              ? "Uploading..."
              : submitLabel}
        </Button>
      </div>
    </div>
  );
}
