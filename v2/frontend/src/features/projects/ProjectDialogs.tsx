import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProjectMetaFields } from "@/features/projects/ProjectMetaFields";
import { useDeleteProject, useUpdateProject } from "@/features/projects/api";
import { metaFormFrom, metaPayload, projectMetaSchema, type ProjectMetaForm } from "@/features/projects/schema";
import type { Project } from "@/lib/api/types";

interface TargetProps {
  project: Project | null;
  onClose: () => void;
}

export function EditProjectDialog({ project, onClose }: TargetProps) {
  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono uppercase tracking-wider text-brand">
            <Pencil size={16} /> Edit project details
          </DialogTitle>
          <DialogDescription>Update project, partner and revenue-share details.</DialogDescription>
        </DialogHeader>
        {project && <EditProjectForm project={project} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function EditProjectForm({ project, onClose }: { project: Project; onClose: () => void }) {
  const form = useForm<ProjectMetaForm>({ resolver: zodResolver(projectMetaSchema), defaultValues: metaFormFrom(project) });
  const update = useUpdateProject(project.id);
  const submit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync({ ...metaPayload(values), expected_version: project.version });
      toast.success("Project updated");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    }
  });
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <ProjectMetaFields form={form} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending && <Loader2 className="animate-spin" />} Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** v1 two-step safeguard: the exact project name must be typed before the delete button enables. */
export function DeleteProjectDialog({ project, onClose }: TargetProps) {
  const [typed, setTyped] = useState("");
  const remove = useDeleteProject();
  useEffect(() => setTyped(""), [project]);
  const matches = Boolean(project) && typed.trim() === project?.name.trim();
  const confirm = async () => {
    if (!project) return;
    try {
      await remove.mutateAsync({ id: project.id, confirm: typed.trim() });
      toast.success(`Deleted ${project.name}`);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed");
    }
  };
  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono uppercase tracking-wider text-rose-700">
            <Trash2 size={16} /> Delete project
          </DialogTitle>
          <DialogDescription>
            This removes the project and all of its stores and progress. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-name">
            Type <span className="font-mono font-semibold">{project?.name}</span> to confirm
          </Label>
          <Input id="confirm-name" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!matches || remove.isPending} onClick={confirm}>
            {remove.isPending && <Loader2 className="animate-spin" />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
