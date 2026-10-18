import { describe, expect, it } from "vitest";
import { jobPollInterval } from "@/features/imports/api";

describe("jobPollInterval", () => {
  it("polls while queued, running or not loaded yet", () => {
    expect(jobPollInterval({ status: "pending" })).toBe(1_500);
    expect(jobPollInterval({ status: "success", data: { status: "queued" } })).toBe(1_500);
    expect(jobPollInterval({ status: "success", data: { status: "running" } })).toBe(1_500);
  });

  it("stops once the job finishes or the poll itself fails", () => {
    expect(jobPollInterval({ status: "success", data: { status: "succeeded" } })).toBe(false);
    expect(jobPollInterval({ status: "success", data: { status: "failed" } })).toBe(false);
    expect(jobPollInterval({ status: "error" })).toBe(false);
    expect(jobPollInterval({ status: "error", data: { status: "running" } })).toBe(false); // stale data, failing poll
  });
});
