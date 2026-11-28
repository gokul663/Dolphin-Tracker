import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MismatchNotice, StoreTagPicker } from "@/features/stores/StoreFlags";
import { TagOptionsSection } from "@/features/settings/TagOptionsSection";
import { makeProject, makeStop } from "@/test/fixtures";
import { mockApi, renderWithProviders } from "@/test/render";

const STORE = "/api/projects/p1/stores/u1";

describe("StoreTagPicker", () => {
  it("offers the project's tags, keeps a removed one on the store, and saves the pick", async () => {
    const { calls } = mockApi({ [`PUT ${STORE}/tag`]: () => makeStop({ tag: "Done" }) });
    renderWithProviders(<StoreTagPicker project={makeProject({ tag_options: ["To Do", "Done"] })} stop={makeStop({ tag: "Escalated" })} />);
    const picker = screen.getByRole("combobox", { name: "Tag" });
    expect(picker.textContent).toBe("Escalated (removed)");
    await userEvent.click(picker);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["No tag", "To Do", "Done", "Escalated (removed)"]);
    await userEvent.click(screen.getByRole("option", { name: "Done" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ tag: "Done" }));
  });

  it("is tinted by the tag, its name always shown; with no tag it is an outlined Add tag button", () => {
    const project = makeProject({ tag_options: ["To Do", "In progress", "Done"] });
    const { unmount } = renderWithProviders(<StoreTagPicker project={project} stop={makeStop({ tag: "To Do" })} />);
    const picker = screen.getByRole("combobox", { name: "Tag" });
    expect(picker.textContent).toBe("To Do");
    expect(picker.className).toContain("bg-amber-50");
    unmount();
    renderWithProviders(<StoreTagPicker project={project} stop={makeStop({ tag: "" })} />);
    const empty = screen.getByRole("combobox", { name: "Tag" });
    expect(empty.textContent).toBe("Add tag");
    expect(empty.className).toContain("border-dashed");
  });

  it("is a plain chip for someone who may not set tags", () => {
    renderWithProviders(<StoreTagPicker project={makeProject()} stop={makeStop({ tag: "In progress" })} />, { role: "viewer" });
    expect(screen.queryByRole("combobox", { name: "Tag" })).toBeNull();
    expect(screen.getByLabelText("Tag: In progress").textContent).toBe("In progress");
    expect(screen.getByLabelText("Tag: In progress").className).toContain("bg-blue-50");
  });
});

describe("MismatchNotice", () => {
  const mismatched = { screen_mismatch: true, committed_screens_total: 3, committed_dolphin_screens: 3, status: "Completed" as const };

  it("shows only while the store has the mismatch", () => {
    const { container } = renderWithProviders(<MismatchNotice project={makeProject()} stop={makeStop()} />);
    expect(container.textContent).toBe("");
  });

  it("Ignore mismatch, then Undo", async () => {
    const { calls } = mockApi({ [`PATCH ${STORE}/progress`]: () => makeStop({ ...mismatched, mismatch_ignored: true }) });
    const { rerender } = renderWithProviders(<MismatchNotice project={makeProject()} stop={makeStop(mismatched)} />);
    expect(screen.getByRole("note", { name: "Screen mismatch" }).textContent).toContain("3 committed, 1 screen row: this store counts in Needs review");
    await userEvent.click(screen.getByRole("button", { name: "Ignore mismatch" }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ ignore_mismatch: true }));
    rerender(<MismatchNotice project={makeProject()} stop={makeStop({ ...mismatched, mismatch_ignored: true })} />);
    expect(screen.getByRole("note", { name: "Screen mismatch" }).textContent).toContain("mismatch ignored");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls[1]?.body).toEqual({ ignore_mismatch: false }));
  });

  it("has no button for someone who cannot edit the store", () => {
    renderWithProviders(<MismatchNotice project={makeProject()} stop={makeStop(mismatched)} />, { role: "operator" });
    expect(screen.queryByRole("button", { name: "Ignore mismatch" })).toBeNull();
  });
});

describe("TagOptionsSection", () => {
  it("adds and removes tags, and saves the whole list", async () => {
    const { calls } = mockApi({ "PUT /api/projects/p1/tag-options": () => makeProject({ tag_options: ["To Do", "Done", "Escalated"] }) });
    renderWithProviders(<TagOptionsSection project={makeProject()} />);
    const save = screen.getByRole("button", { name: "Save tags" });
    expect(save).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "Remove In progress" }));
    await userEvent.type(screen.getByLabelText("New tag"), "  Escalated {Enter}");
    await userEvent.type(screen.getByLabelText("New tag"), "done");
    expect(screen.getByText("Already in the list")).toBeTruthy();
    await userEvent.click(save);
    await waitFor(() => expect(calls[0]?.body).toEqual({ tag_options: ["To Do", "Done", "Escalated"] }));
  });
});
