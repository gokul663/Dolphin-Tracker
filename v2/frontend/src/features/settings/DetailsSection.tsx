import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ProjectMetaFields } from "@/features/projects/ProjectMetaFields";
import { useUpdateProject } from "@/features/projects/api";
import { metaFormFrom, metaPayload, projectMetaSchema, type ProjectMetaForm } from "@/features/projects/schema";
import type { Project } from "@/lib/api/types";

export function DetailsSection({ project }: { project: Project }) {
  const form = useForm<ProjectMetaForm>({
    resolver: zodResolver(projectMetaSchema),
    defaultValues: metaFormFrom(project),
    values: metaFormFrom(project),
    resetOptions: { keepDirtyValues: true },
  });
  const update = useUpdateProject(project.id);
  const submit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync({ ...metaPayload(values), expected_version: project.version });
      toast.success("Project details saved");
      form.reset(values);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    }
  });
  return (
    <Card className="gap-4 p-5">
      <SectionTitle title="Project details" />
      <form onSubmit={submit} noValidate className="space-y-4">
        <ProjectMetaFields form={form} />
        <div className="flex justify-end">
          <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
            {update.isPending && <Loader2 className="animate-spin" />} Save details
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">{title}</h2>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
    </div>
  );
}
