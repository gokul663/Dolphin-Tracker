import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useImportResult, useJob } from "@/features/imports/api";
import { DetailsStep } from "@/features/imports/DetailsStep";
import { MappingStep } from "@/features/imports/MappingStep";
import {
  autoMap,
  buildStops,
  extendedSchema,
  mappableColumns,
  mappedValueProblems,
  mappingErrors,
  reviewSummary,
  toReviewRows,
  type ColumnMapping,
  type ReviewRow,
} from "@/features/imports/model";
import { ReviewStep } from "@/features/imports/ReviewStep";
import { UploadStep } from "@/features/imports/UploadStep";
import { EMPTY_DETAILS, wizardDetailsSchema, type WizardDetails } from "@/features/imports/wizardSchema";
import { useDefaultFieldSchema } from "@/features/places/api";
import { useCreateProject, useUpdateProject } from "@/features/projects/api";
import { metaPayload } from "@/features/projects/schema";
import { useAppendStores } from "@/features/stores/api";
import { ApiError, type AppendResult, type FieldDef, type Project } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export interface ImportWizardProps {
  open: boolean;
  onClose: () => void;
  /** Set to append stores to an existing project instead of creating a new one. */
  appendTo?: Project | null;
}

type Step = "details" | "upload" | "review" | "mapping" | "done";

export function ImportWizard({ open, onClose, appendTo }: ImportWizardProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        {/* Remounting per open resets every step. */}
        {open && <WizardBody key={appendTo?.id ?? "new"} appendTo={appendTo ?? null} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function WizardBody({ appendTo, onClose }: { appendTo: Project | null; onClose: () => void }) {
  const navigate = useNavigate();
  const steps: Step[] = appendTo ? ["upload", "review", "mapping"] : ["details", "upload", "review", "mapping"];
  const [step, setStep] = useState<Step>(steps[0] as Step);
  const details = useForm<WizardDetails>({ resolver: zodResolver(wizardDetailsSchema), defaultValues: EMPTY_DETAILS });
  const [installers, setInstallers] = useState<string[]>([]);
  const [installerError, setInstallerError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const result = useImportResult(job.data);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dropInvalid, setDropInvalid] = useState(false);
  const [appended, setAppended] = useState<AppendResult | null>(null);
  const savedProject = useRef<Project | null>(null); // the project as the last successful schema PATCH returned it
  const defaults = useDefaultFieldSchema();
  const schema: FieldDef[] = useMemo(() => appendTo?.field_schema ?? defaults.data ?? [], [appendTo, defaults.data]);

  // When the job's result (and the schema to map against) arrive: seed review rows and the automatic mapping.
  // Keyed on the result only, so later schema refetches never discard review edits.
  const ready = Boolean(result.data) && (Boolean(appendTo) || defaults.isSuccess);
  useEffect(() => {
    if (!result.data || !ready) return;
    setRows(toReviewRows(result.data));
    setMapping(autoMap(mappableColumns(result.data), schema));
    if (!appendTo && !details.getValues("pa") && result.data.pa_names.length) {
      details.setValue("pa", result.data.pa_names.join(", "));
    }
    setStep("review");
  }, [result.data, ready]);

  const columns = useMemo(() => (result.data ? mappableColumns(result.data) : []), [result.data]);
  const targetSchema = useMemo(() => extendedSchema(schema, mapping), [schema, mapping]);
  const errors = mappingErrors(mapping);
  const problems = useMemo(() => mappedValueProblems(rows, mapping, targetSchema), [rows, mapping, targetSchema]);
  const blockingProblems = problems.filter((problem) => problem.message.endsWith("is required"));
  const summary = reviewSummary(rows);
  const create = useCreateProject();
  const append = useAppendStores(appendTo?.id ?? "");
  const updateSchema = useUpdateProject(appendTo?.id ?? "");
  const saving = create.isPending || append.isPending || updateSchema.isPending;
  const canSubmit =
    summary.ready > 0 && errors.length === 0 && blockingProblems.length === 0 && (problems.length === 0 || dropInvalid);

  // Installers live outside the form; report them together with the form's own errors, not after them.
  const checkInstallers = () => {
    const error = installers.length === 0 ? "Add at least one installer" : null;
    setInstallerError(error);
    return error === null;
  };
  const nextFromDetails = details.handleSubmit(
    () => checkInstallers() && setStep("upload"),
    () => checkInstallers(),
  );

  const submit = async () => {
    const stops = buildStops(rows, mapping, targetSchema, { dropInvalid });
    try {
      if (appendTo) {
        // A retry after a failed append builds on the schema PATCH that already succeeded (its new version),
        // instead of resending the dashboard's stale version and getting 409 forever.
        const base = savedProject.current ?? appendTo;
        if (targetSchema.length > base.field_schema.length) {
          savedProject.current = await updateSchema.mutateAsync({ field_schema: targetSchema, expected_version: base.version });
        }
        const pa = rows.filter((row) => !row.excluded).map((row) => row.pa).filter(Boolean);
        setAppended(await append.mutateAsync({ stops, pa: [...new Set(pa)].join(", ") }));
        setStep("done");
        return;
      }
      const values = details.getValues();
      const created = await create.mutateAsync({
        ...metaPayload(values),
        installers,
        stops_per_day: values.stops_per_day,
        field_schema: targetSchema,
        stops,
      });
      toast.success(`Created ${created.project.name} with ${stops.length} stores${created.job_id ? "; routing has started" : ""}`);
      onClose();
      navigate(`/projects/${created.project.id}/stores`);
    } catch (error) {
      const detail = error instanceof ApiError ? error.validation : null;
      const rowErrors = detail?.stops?.slice(0, 3).map((row) => `stop ${row.index + 1}: ${row.errors.join(", ")}`) ?? [];
      toast.error([error instanceof Error ? error.message : "Import failed", ...rowErrors].join(" — "));
    }
  };

  const titles: Record<Step, string> = {
    details: "Project details",
    upload: "Upload the store list",
    review: "Review addresses",
    mapping: "Map columns to store fields",
    done: "Stores appended",
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono uppercase tracking-wider text-brand">
          {appendTo ? `Append to ${appendTo.name}` : "New project"} · {titles[step]}
        </DialogTitle>
        <DialogDescription asChild>
          <ol className="flex flex-wrap gap-1.5 font-mono text-[10px] uppercase tracking-wider">
            {steps.map((name, index) => (
              <li
                key={name}
                aria-current={name === step ? "step" : undefined}
                className={cn("rounded-full border px-2 py-0.5", name === step ? "border-brand bg-brand text-white" : "text-slate-500")}
              >
                {index + 1}. {titles[name]}
              </li>
            ))}
          </ol>
        </DialogDescription>
      </DialogHeader>

      {step === "details" && (
        <form onSubmit={nextFromDetails} noValidate className="space-y-4">
          <DetailsStep form={details} installers={installers} onInstallersChange={setInstallers} installerError={installerError} />
          <div className="flex justify-end">
            <Button type="submit">
              Next <ArrowRight />
            </Button>
          </div>
        </form>
      )}

      {step === "upload" && (
        <div className="space-y-4">
          <UploadStep projectId={appendTo?.id} jobId={jobId} onJobId={setJobId} />
          {result.isFetching && <p className="font-mono text-xs text-slate-500">Loading the verified rows…</p>}
          {result.isError && (
            <FetchError
              message={`Could not load the verified rows: ${result.error.message}`}
              retrying={result.isFetching}
              onRetry={() => void result.refetch()}
            />
          )}
          {!appendTo && defaults.isError && (
            <FetchError
              message={`Could not load the default store fields: ${defaults.error.message}`}
              retrying={defaults.isFetching}
              onRetry={() => void defaults.refetch()}
            />
          )}
          {!appendTo && (
            <Button variant="ghost" onClick={() => setStep("details")}>
              <ArrowLeft /> Back
            </Button>
          )}
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <ReviewStep rows={rows} onRowsChange={setRows} />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("upload")}>
              <ArrowLeft /> Upload another file
            </Button>
            <Button onClick={() => setStep("mapping")} disabled={summary.ready === 0}>
              Next: map columns ({summary.ready} ready) <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {step === "mapping" && (
        <div className="space-y-4">
          <MappingStep
            columns={columns}
            rows={rows}
            schema={schema}
            mapping={mapping}
            onMappingChange={setMapping}
            errors={errors}
            problems={problems}
            dropInvalid={dropInvalid}
            onDropInvalidChange={setDropInvalid}
          />
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("review")}>
              <ArrowLeft /> Back to review
            </Button>
            <Button onClick={submit} disabled={!canSubmit || saving}>
              {saving && <Loader2 className="animate-spin" />}
              {appendTo ? `Append ${summary.ready} stores` : `Create project with ${summary.ready} stores`}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && appended && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-5 text-emerald-600" />
            Appended {appended.appended} stores; the project now has {appended.total}.
          </p>
          {appended.skipped.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">{appended.skipped.length} skipped as duplicates (same venue code or address):</p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5">
                {appended.skipped.map((skip, index) => (
                  <li key={`${skip.addr}-${index}`}>
                    {skip.addr}
                    {skip.venue_code ? ` (venue ${skip.venue_code})` : ""}
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

/** A failed fetch the wizard depends on: say so and offer a retry, instead of sitting on "succeeded 100%". */
function FetchError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
      <span>{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
        {retrying && <Loader2 className="animate-spin" />} Retry
      </Button>
    </div>
  );
}
