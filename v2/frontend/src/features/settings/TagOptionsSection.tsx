import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSetTagOptions } from "@/features/projects/api";
import { SectionTitle } from "@/features/settings/DetailsSection";
import { useCan } from "@/lib/auth/me";
import type { Project } from "@/lib/api/types";

const clean = (text: string) => text.trim().replace(/\s+/g, " ");

/** The tags a store of this project may carry (the manager's escalation marker in the store window). Removing one
 *  leaves it on the stores that carry it until someone changes it there. */
export function TagOptionsSection({ project }: { project: Project }) {
  const canEdit = useCan("stores.tag");
  const save = useSetTagOptions(project.id);
  const [options, setOptions] = useState<string[]>(project.tag_options);
  const [adding, setAdding] = useState("");
  useEffect(() => setOptions(project.tag_options), [project.tag_options]);
  const dirty = options.join("\n") !== project.tag_options.join("\n");
  const next = clean(adding);
  const repeat = options.some((option) => option.toLowerCase() === next.toLowerCase());
  const add = () => {
    if (!next || repeat) return;
    setOptions([...options, next]);
    setAdding("");
  };
  const submit = async () => {
    try {
      await save.mutateAsync(options);
      toast.success("Tags saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    }
  };
  return (
    <Card className="gap-4 p-5" aria-label="Store tags">
      <SectionTitle title="Store tags" hint="What a project manager can mark a store with, apart from its status. Removing a tag keeps it on the stores that have it." />
      {options.length === 0 ? (
        <p className="text-sm text-slate-500">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tag options">
          {options.map((option) => (
            <li key={option} className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 py-0.5 pr-1 pl-2.5 text-xs font-medium text-violet-800">
              {option}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${option}`}
                  className="rounded-full p-0.5 text-violet-500 hover:bg-violet-100 hover:text-violet-800"
                  onClick={() => setOptions(options.filter((item) => item !== option))}
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Input aria-label="New tag" placeholder="New tag, e.g. Escalated" maxLength={50} value={adding} onChange={(event) => setAdding(event.target.value)} className="h-8 max-w-60" />
            <Button type="submit" size="sm" variant="outline" disabled={!next || repeat}>
              <Plus /> Add
            </Button>
            {repeat && <span className="text-xs text-amber-700">Already in the list</span>}
          </form>
          <div className="flex justify-end">
            <Button type="button" disabled={!dirty || save.isPending} onClick={() => void submit()}>
              {save.isPending && <Loader2 className="animate-spin" />} Save tags
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
