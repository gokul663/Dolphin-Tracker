import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProjectMetaFields } from "@/features/projects/ProjectMetaFields";
import { useUpdateProject } from "@/features/projects/api";
import { metaFormFrom, metaPayload, projectMetaSchema } from "@/features/projects/schema";
import type { Project } from "@/lib/api/types";

const detailsSchema = projectMetaSchema.extend({
  stops_per_day: z.coerce.number().int("Whole number").min(1, "At least 1").max(50, "At most 50"),
});
type DetailsForm = z.infer<typeof detailsSchema>;

export function DetailsSection({ project }: { project: Project }) {
  const form = useForm<DetailsForm>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { ...metaFormFrom(project), stops_per_day: project.stops_per_day },
    values: { ...metaFormFrom(project), stops_per_day: project.stops_per_day },
    resetOptions: { keepDirtyValues: true },
  });
  const update = useUpdateProject(project.id);
  const submit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync({
        ...metaPayload(values),
        stops_per_day: values.stops_per_day,
        expected_version: project.version,
      });
      toast.success("Project details saved");
      form.reset(values);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    }
  });
  return (
    <Card className="gap-4 p-5">
      <SectionTitle title="Project details" hint="Changing the stops-per-day cap applies from the next routing build." />
      <form onSubmit={submit} noValidate className="space-y-4">
        <ProjectMetaFields form={form} />
        <div className="max-w-48 space-y-1.5">
          <Label htmlFor="stops-per-day" className="font-mono text-[11px] uppercase tracking-wider text-slate-600">
            Stops per day (1–50)
          </Label>
          <Input id="stops-per-day" type="number" min={1} max={50} {...form.register("stops_per_day")} />
          {form.formState.errors.stops_per_day && (
            <p className="text-xs text-rose-600">{form.formState.errors.stops_per_day.message}</p>
          )}
        </div>
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
