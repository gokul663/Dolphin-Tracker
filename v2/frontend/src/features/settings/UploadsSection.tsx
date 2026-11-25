import { centralTime } from "@/lib/time";
import { useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ImportWizard } from "@/features/imports/ImportWizard";
import { SectionTitle } from "@/features/settings/DetailsSection";
import { keys } from "@/lib/api/keys";
import { projectsApi } from "@/lib/api/resources";
import type { Project } from "@/lib/api/types";

const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Every sheet imported into the project, kept for good, newest first, with a download; and the way to upload
 *  another one (new stores are added, stores already there are left as they are). */
export function UploadsSection({ project }: { project: Project }) {
  const [importing, setImporting] = useState(false);
  const uploads = useQuery({ queryKey: keys.projectUploads(project.id), queryFn: () => projectsApi.uploads(project.id) });
  const items = uploads.data?.items ?? [];
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle
          title="Uploaded sheets"
          hint="Every sheet imported into this project is kept here. Uploading another adds its new stores; a store already in the project (same ExtID or address) is skipped, not updated."
        />
        <Button onClick={() => setImporting(true)}>
          <Upload /> Upload a sheet
        </Button>
      </div>
      {uploads.isError && <p className="text-sm text-rose-700">Could not load the uploads: {uploads.error.message}</p>}
      {uploads.isSuccess && items.length === 0 && (
        <p className="text-sm text-slate-500">No sheet kept yet. Sheets uploaded from now on are listed here.</p>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-slate-100" aria-label="Uploaded sheets">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <FileSpreadsheet className="size-5 shrink-0 text-emerald-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{item.filename}</p>
                <p className="text-xs text-slate-500">
                  {centralTime(item.uploaded_at)} · {size(item.size)} · {item.kind === "create" ? "created the project" : "added to the project"}
                </p>
              </div>
              <p className="text-xs text-slate-600">
                <span className="font-semibold text-slate-900">{item.added.toLocaleString()}</span> added
                {item.skipped > 0 && (
                  <>
                    {" · "}
                    <span className="font-semibold text-amber-700">{item.skipped.toLocaleString()}</span> already there
                  </>
                )}
              </p>
              <Button asChild size="sm" variant="outline">
                <a href={item.download_url} download={item.filename}>
                  <Download /> Download
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ImportWizard open={importing} appendTo={project} onClose={() => setImporting(false)} />
    </Card>
  );
}
