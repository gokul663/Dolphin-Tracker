import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Project } from "@/lib/api/types";

export interface ImportWizardProps {
  open: boolean;
  onClose: () => void;
  /** Set to append stores to an existing project instead of creating a new one. */
  appendTo?: Project | null;
}

/** Placeholder until F4 lands the details → upload → review → mapping flow. */
export function ImportWizard({ open, onClose, appendTo }: ImportWizardProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{appendTo ? `Append to ${appendTo.name}` : "New project"}</DialogTitle>
          <DialogDescription>The import wizard is part of task F4.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
