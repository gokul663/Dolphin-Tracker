import { useMutation, useQuery } from "@tanstack/react-query";
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

/** Poll a job every 1.5 s until it succeeds or fails. */
export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: keys.job(jobId ?? ""),
    queryFn: () => jobsApi.get(jobId ?? ""),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (!query.state.data || isJobActive(query.state.data) ? 1_500 : false),
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
