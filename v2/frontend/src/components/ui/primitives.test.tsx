import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

describe("shadcn primitives", () => {
  it("render with the brand primary token and respond to input", async () => {
    render(
      <div>
        <Button>Save</Button>
        <Badge variant="secondary">Complete</Badge>
        <Checkbox aria-label="Additional task" />
      </div>,
    );
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("bg-primary");
    expect(screen.getByText("Complete")).toBeTruthy();
    const box = screen.getByRole("checkbox", { name: "Additional task" });
    await userEvent.click(box);
    expect(box.getAttribute("data-state")).toBe("checked");
  });
});
