import { Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/auth/me";
import { cn } from "@/lib/utils";
import { SECTION_TONE, type ToneName } from "@/features/stores/sectionTone";

/** A section's or card's icon in a small chip of its hue (decoration: the title beside it names the section). */
export function ToneChip({ name, className }: { name: ToneName; className?: string }) {
  const { icon: Icon, chip } = SECTION_TONE[name];
  return (
    <span aria-hidden className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md", chip, className)}>
      <Icon size={13} strokeWidth={2.25} />
    </span>
  );
}

/** Edit, then View to see the section as text again. Neither saves nor drops anything: the window's Save and
 *  Discard do that for every section at once. Shown only to someone who may edit. */
export function EditToggle({
  label,
  editing,
  disabled = false,
  className,
  onEdit,
  onView,
}: {
  label: string;
  editing: boolean;
  disabled?: boolean;
  className?: string;
  onEdit: () => void;
  onView: () => void;
}) {
  const canEdit = useCan("projects.edit");
  if (!canEdit) return null; // view only: nothing opens for editing
  return editing ? (
    <Button type="button" size="sm" variant="outline" className={cn("relative h-8 after:absolute after:-inset-1", className)} aria-label={`View ${label}`} disabled={disabled} title={disabled ? "Fix the highlighted value first" : "Back to the text view; the changes stay until you save or discard"} onClick={onView}>
      <Eye /> View
    </Button>
  ) : (
    <Button type="button" size="sm" variant="outline" className={cn("relative h-8 after:absolute after:-inset-1", className)} aria-label={`Edit ${label}`} onClick={onEdit}>
      <Pencil /> Edit
    </Button>
  );
}
