import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  useImportResult,
  useJob,
  useRemapImport,
} from "@/features/imports/api";
import { DetailsStep } from "@/features/imports/DetailsStep";
import { MappingStep } from "@/features/imports/MappingStep";
import {
  buildStops,
  reviewSummary,
  toReviewRows,
  valueProblemColumns,
  type ReviewRow,
} from "@/features/imports/model";
import { ReviewStep } from "@/features/imports/ReviewStep";
import { UploadStep } from "@/features/imports/UploadStep";
import {
  EMPTY_DETAILS,
  wizardDetailsSchema,
  type WizardDetails,
} from "@/features/imports/wizardSchema";
import { useStoreFields } from "@/features/places/api";
import { useCreateProject } from "@/features/projects/api";
import { metaPayload } from "@/features/projects/schema";
import { useAppendStores } from "@/features/stores/api";
import { ApiError, type AppendResult, type Project } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export interface ImportWizardProps {
  open: boolean;
  onClose: () => void;
  /** Set to append stores to an existing project instead of creating a new one. */
  appendTo?: Project | null;
}

type Step = "details" | "upload" | "columns" | "review" | "done";

export function ImportWizard({ open, onClose, appendTo }: ImportWizardProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-[min(1400px,95vw)]">
        {/* Remounting per open resets every step. */}
        {open && (
          <WizardBody
            key={appendTo?.id ?? "new"}
            appendTo={appendTo ?? null}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A failed fetch the wizard depends on: say so and offer a retry, instead of sitting on "succeeded 100%". */
function FetchError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
    >
      <span>{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
        {retrying && <Loader2 className="animate-spin" />} Retry
      </Button>
    </div>
  );
}

function WizardBody({
  appendTo,
  onClose,
}: {
  appendTo: Project | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const steps: Step[] = appendTo
    ? ["upload", "columns", "review"]
    : ["details", "upload", "columns", "review"];
  const [step, setStep] = useState<Step>(steps[0] as Step);
  const details = useForm<WizardDetails>({
    resolver: zodResolver(wizardDetailsSchema),
    defaultValues: EMPTY_DETAILS,
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const result = useImportResult(job.data);
  const remap = useRemapImport(jobId);
  const specs = useStoreFields();
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [dropInvalid, setDropInvalid] = useState(false);
  const [appended, setAppended] = useState<AppendResult | null>(null);

  // A (re-mapped) result rebuilds the review rows. Re-pointing a column happens before the review, so no edits are
  // lost; going back to Columns and re-pointing again does reset them (the step says so).
  const [seeded, setSeeded] = useState<unknown>(null);
  useEffect(() => {
    if (!result.data || result.data === seeded) return;
    const first = seeded === null;
    setSeeded(result.data);
    setRows(toReviewRows(result.data));
    if (first) setStep("columns");
  }, [result.data]);

  const summary = reviewSummary(rows);
  const create = useCreateProject();
  const append = useAppendStores(appendTo?.id ?? "");
  const saving = create.isPending || append.isPending;
  // Several PAs (no single PA name): every store must bring its PA from the sheet's PA column.
  const missingPa =
    !appendTo &&
    !details.getValues("single_pa") &&
    rows.some((row) => !row.excluded && !row.pa.trim());
  const canSubmit =
    summary.ready > 0 &&
    (summary.withValueProblems === 0 || dropInvalid) &&
    !missingPa;

  const nextFromDetails = details.handleSubmit(() => setStep("upload"));

  const repoint = (column: string, target: string) => {
    if (!result.data) return;
    remap.mutate(
      { ...result.data.mapping, [column]: target },
      {
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not re-map the column",
          ),
      },
    );
  };
  const remapError =
    remap.error instanceof ApiError
      ? (remap.error.validation?.errors ?? [remap.error.message]).join(" · ")
      : null;

  const submit = async () => {
    const stops = buildStops(rows, { dropInvalid });
    const importMapping = result.data?.mapping ?? {};
    try {
      if (appendTo) {
        const pa = rows
          .filter((row) => !row.excluded)
          .map((row) => row.pa)
          .filter(Boolean);
        setAppended(
          await append.mutateAsync({
            stops,
            pa: [...new Set(pa)].join(", "),
            import_mapping: importMapping,
          }),
        );
        setStep("done");
        return;
      }
      const values = details.getValues();
      const created = await create.mutateAsync({
        ...metaPayload(values),
        stops,
        import_mapping: importMapping,
      });
      const skipped = created.skipped.length
        ? `; ${created.skipped.length} skipped as duplicates`
        : "";
      toast.success(
        `Created ${created.project.name} with ${stops.length - created.skipped.length} stores${skipped}`,
      );
      onClose();
      navigate(`/projects/${created.project.id}/stores`);
    } catch (error) {
      const detail = error instanceof ApiError ? error.validation : null;
      const rowErrors =
        detail?.stops
          ?.slice(0, 3)
          .map((row) => `stop ${row.index + 1}: ${row.errors.join(", ")}`) ??
        [];
      toast.error(
        [
          error instanceof Error ? error.message : "Import failed",
          ...rowErrors,
        ].join(" — "),
      );
    }
  };

  const titles: Record<Step, string> = {
    details: "Project details",
    upload: "Upload the store list",
    columns: "Check the columns",
    review: "Review the stores",
    done: "Stores appended",
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono uppercase tracking-wider text-brand">
          {appendTo ? `Append to ${appendTo.name}` : "New project"} ·{" "}
          {titles[step]}
        </DialogTitle>
        <DialogDescription asChild>
          <ol className="flex flex-wrap gap-1.5 font-mono text-[10px] uppercase tracking-wider">
            {steps.map((name, index) => (
              <li
                key={name}
                aria-current={name === step ? "step" : undefined}
                className={cn(
                  "rounded-full border px-2 py-0.5",
                  name === step
                    ? "border-brand bg-brand text-white"
                    : "text-slate-500",
                )}
              >
                {index + 1}. {titles[name]}
              </li>
            ))}
          </ol>
        </DialogDescription>
      </DialogHeader>

      {step === "details" && (
        <form onSubmit={nextFromDetails} noValidate className="space-y-4">
          <DetailsStep form={details} />
          <div className="flex justify-end">
            <Button type="submit">
              Next <ArrowRight />
            </Button>
          </div>
        </form>
      )}

      {step === "upload" && (
        <div className="space-y-4">
          <UploadStep
            projectId={appendTo?.id}
            jobId={jobId}
            onJobId={setJobId}
          />
          {result.isFetching && (
            <p className="font-mono text-xs text-slate-500">
              Loading the verified rows…
            </p>
          )}
          {result.isError && (
            <FetchError
              message={`Could not load the verified rows: ${result.error.message}`}
              retrying={result.isFetching}
              onRetry={() => void result.refetch()}
            />
          )}
          <div className="flex justify-between">
            {!appendTo ? (
              <Button variant="ghost" onClick={() => setStep("details")}>
                <ArrowLeft /> Back
              </Button>
            ) : (
              <span />
            )}
            {result.data && rows.length > 0 && (
              <Button variant="outline" onClick={() => setStep("columns")}>
                Continue to the columns <ArrowRight />
              </Button>
            )}
          </div>
        </div>
      )}

      {step === "columns" && result.data && (
        <div className="space-y-4">
          {specs.data ? (
            <MappingStep
              result={result.data}
              specs={specs.data}
              onRepoint={repoint}
              pending={remap.isPending}
              error={remapError}
            />
          ) : specs.isError ? (
            <FetchError
              message={`Could not load the store fields: ${specs.error.message}`}
              retrying={specs.isFetching}
              onRetry={() => void specs.refetch()}
            />
          ) : (
            <p className="font-mono text-xs text-slate-500">
              Loading the store fields…
            </p>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("upload")}>
              <ArrowLeft /> Upload another file
            </Button>
            <Button
              onClick={() => setStep("review")}
              disabled={remap.isPending}
            >
              Next: review {summary.total} rows <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <ReviewStep rows={rows} onRowsChange={setRows} />
          {summary.withValueProblems > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <Checkbox
                id="drop-invalid"
                checked={dropInvalid}
                onCheckedChange={(checked) => setDropInvalid(checked === true)}
              />
              <Label htmlFor="drop-invalid">
                {summary.withValueProblems} of all {summary.total} rows have
                values that cannot be used (
                {valueProblemColumns(rows)
                  .map(([column, count]) => `${column} · ${count}`)
                  .join(", ")}
                ; see the "with unusable values" filter above). Import them
                without those values
              </Label>
            </div>
          )}
          {missingPa && (
            <p
              role="alert"
              className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              Some stores have no PA. The project is set to several PAs, so each
              store needs one from the sheet's PA column: map that column in the
              columns step, or go back to the project details and enter a single
              PA.
            </p>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("columns")}>
              <ArrowLeft /> Back to the columns
            </Button>
            <Button onClick={submit} disabled={!canSubmit || saving}>
              {saving && <Loader2 className="animate-spin" />}
              {appendTo
                ? `Append ${summary.ready} stores`
                : `Create project with ${summary.ready} stores`}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && appended && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-5 text-emerald-600" />
            Appended {appended.appended} stores; the project now has{" "}
            {appended.total}.
          </p>
          {appended.skipped.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">
                {appended.skipped.length} skipped as duplicates (same IBC# or
                address):
              </p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5">
                {appended.skipped.map((skip) => (
                  <li key={skip.index}>
                    {skip.store_name || skip.addr} ·{" "}
                    {skip.reason === "external_id"
                      ? `IBC# ${skip.external_id}`
                      : skip.addr}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={() => {
                onClose();
                navigate(`/projects/${appendTo?.id}/stores`);
              }}
            >
              Open project
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
