import { useState } from "react";
import { Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SectionTitle } from "@/features/settings/DetailsSection";
import { useRenameInstaller, useRoutingJob } from "@/features/projects/api";
import type { Project } from "@/lib/api/types";

export function InstallersSection({ project }: { project: Project }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ from: string; to: string } | null>(null);
  const job = useRoutingJob(project.id);
  const rename = useRenameInstaller(project.id);
  const building = project.routing_status === "building";
  const trimmed = name.trim();
  const duplicate = project.installers.includes(trimmed);

  const add = async () => {
    try {
      await job.mutateAsync({ kind: "add_installer", name: trimmed });
      setName("");
      toast.success(`Adding ${trimmed}: routes are being rebalanced`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add installer");
    }
  };
  const saveRename = async () => {
    if (!editing) return;
    try {
      await rename.mutateAsync({ oldName: editing.from, newName: editing.to.trim() });
      toast.success(`Renamed ${editing.from} to ${editing.to.trim()}`);
      setEditing(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Rename failed");
    }
  };

  return (
    <Card className="gap-4 p-5">
      <SectionTitle
        title="Installers"
        hint="Adding an installer gives them a share of the upcoming stores (a routing job). Renaming is instant."
      />
      <ul className="divide-y rounded-lg border">
        {project.installers.map((installer) => (
          <li key={installer} className="flex items-center gap-2 px-3 py-2">
            {editing?.from === installer ? (
              <>
                <Input
                  aria-label={`New name for ${installer}`}
                  value={editing.to}
                  onChange={(event) => setEditing({ from: installer, to: event.target.value })}
                  onKeyDown={(event) => event.key === "Enter" && saveRename()}
                  className="h-8"
                  autoFocus
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Save name"
                  onClick={saveRename}
                  disabled={!editing.to.trim() || rename.isPending}
                >
                  {rename.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                </Button>
                <Button size="icon" variant="ghost" aria-label="Cancel rename" onClick={() => setEditing(null)}>
                  <X />
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 font-medium">{installer}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Rename ${installer}`}
                  disabled={building}
                  onClick={() => setEditing({ from: installer, to: installer })}
                >
                  <Pencil />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          aria-label="New installer name"
          placeholder="New installer name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && trimmed && !duplicate && !building && add()}
        />
        <Button onClick={add} disabled={!trimmed || duplicate || building || job.isPending}>
          {job.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Add installer
        </Button>
      </div>
      {duplicate && <p className="text-xs text-rose-600">An installer with that name already exists.</p>}
      {building && <p className="text-xs text-slate-500">Installer changes are paused while routing runs.</p>}
    </Card>
  );
}
