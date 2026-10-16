import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { isJobActive, useJob, useStartImport } from "@/features/imports/api";

interface Props {
  projectId?: string;
  jobId: string | null;
  onJobId: (jobId: string) => void;
}

/** Step 2: upload the sheet (presigned PUT or the local route), start the job, show its real progress. */
export function UploadStep({ projectId, jobId, onJobId }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const start = useStartImport();
  const job = useJob(jobId);
  const running = start.isPending || isJobActive(job.data);
  const failed = job.data?.status === "failed" ? job.data.message : start.error?.message;

  const begin = async () => {
    if (!file) return;
    const id = await start.mutateAsync({ file, projectId }).catch(() => null);
    if (id) onJobId(id);
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = event.dataTransfer.files[0];
          if (dropped) setFile(dropped);
        }}
        disabled={running}
        className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center hover:border-brand/50 disabled:opacity-60"
      >
        <FileSpreadsheet className="size-8 text-brand" />
        <span className="font-medium">{file ? file.name : "Choose or drop a .csv or .xlsx file"}</span>
        <span className="text-xs text-slate-500">Needs an address column; a store name column is strongly recommended.</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        aria-label="Spreadsheet file"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      {(running || job.data) && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex justify-between font-mono text-xs text-slate-600">
            <span>{start.isPending ? "Uploading…" : (job.data?.message ?? "Queued")}</span>
            <span>{job.data?.progress ?? 0}%</span>
          </div>
          <Progress value={job.data?.progress ?? 0} aria-label="Import progress" />
        </div>
      )}
      {failed && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{failed}</p>}
      <div className="flex justify-end">
        <Button onClick={begin} disabled={!file || running}>
          {running ? <Loader2 className="animate-spin" /> : <Upload />} {jobId && failed ? "Try again" : "Upload and verify"}
        </Button>
      </div>
    </div>
  );
}
