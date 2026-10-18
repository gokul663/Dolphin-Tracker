import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditableCell } from "@/features/stores/EditableCell";

function setup(onSave = vi.fn(() => Promise.resolve()), validate = (_value: string): string | null => null) {
  render(<EditableCell label="store name" value="Alpha" validate={validate} onSave={onSave} />);
  return onSave;
}

describe("EditableCell", () => {
  it("saves once on Enter, even though the input then blurs", async () => {
    let resolve: () => void = () => {};
    const onSave = setup(vi.fn(() => new Promise<void>((done) => (resolve = done))));
    await userEvent.click(screen.getByRole("button", { name: "Edit store name" }));
    const input = screen.getByLabelText("store name");
    await userEvent.clear(input);
    await userEvent.type(input, "Beta{Enter}");
    input.blur(); // focus leaves while the PATCH is in flight
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit store name" })).toBeTruthy());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Beta");
  });

  it("saves on blur", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: "Edit store name" }));
    await userEvent.type(screen.getByLabelText("store name"), " Mart");
    await userEvent.tab();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Alpha Mart"));
  });

  it("Escape cancels without saving", async () => {
    const onSave = setup();
    await userEvent.click(screen.getByRole("button", { name: "Edit store name" }));
    await userEvent.type(screen.getByLabelText("store name"), "zzz{Escape}");
    expect(screen.getByRole("button", { name: "Edit store name" }).textContent).toBe("Alpha");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps an invalid value in the editor with the message", async () => {
    const onSave = setup(undefined, (value) => (value ? null : "Store name is required"));
    await userEvent.click(screen.getByRole("button", { name: "Edit store name" }));
    await userEvent.clear(screen.getByLabelText("store name"));
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Store name is required")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
