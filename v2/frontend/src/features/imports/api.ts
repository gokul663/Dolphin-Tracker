import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/api/keys";
import { jobsApi } from "@/lib/api/resources";
import type { JobView } from "@/lib/api/types";

/** Content type for the sheet; the same value is sent to `POST /jobs/imports` and on the upload PUT. */
export function contentTypeFor(file: File): string {
  if (file.type) return file.type;
  return file.name.toLowerCase().endsWith(".csv")
    ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

/** create job → upload (presigned PUT or local route) → start. Resolves with the job id to poll. */
export function useStartImport() {
  return useMutation({
    mutationFn: async ({ file, projectId }: { file: File; projectId?: string }) => {
      const contentType = contentTypeFor(file);
      const created = await jobsApi.createImport({
        filename: file.name,
        content_type: contentType,
        project_id: projectId ?? null,
      });
      await jobsApi.upload(created.upload_url, file, contentType);
      await jobsApi.start(created.job_id);
      return created.job_id;
    },
  });
}

export const isJobActive = (job: Pick<JobView, "status"> | undefined) =>
  job?.status === "queued" || job?.status === "running";

/** 1.5 s while the job is queued or running (or not loaded yet); stop once it finishes or the poll itself fails. */
export function jobPollInterval(state: { status: string; data?: Pick<JobView, "status"> }): number | false {
  if (state.status === "error") return false;
  return !state.data || isJobActive(state.data) ? 1_500 : false;
}

/** Poll a job until it succeeds or fails. */
export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: keys.job(jobId ?? ""),
    queryFn: () => jobsApi.get(jobId ?? ""),
    enabled: Boolean(jobId),
    refetchInterval: (query) => jobPollInterval(query.state),
  });
}

export function useImportResult(job: JobView | undefined) {
  return useQuery({
    queryKey: keys.jobResult(job?.id ?? ""),
    queryFn: () => jobsApi.result(job?.result_url ?? ""),
    enabled: job?.status === "succeeded" && Boolean(job.result_url),
    staleTime: Infinity,
  });
}

/** Re-point columns of a finished import (`POST /jobs/{id}/mapping`); the new result replaces the cached one. */
export function useRemapImport(jobId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mapping: Record<string, string>) => jobsApi.remap(jobId ?? "", mapping),
    onSuccess: (result) => client.setQueryData(keys.jobResult(jobId ?? ""), result),
  });
}
