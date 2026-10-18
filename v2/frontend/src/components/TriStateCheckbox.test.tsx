import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TriStateCheckbox } from "@/components/TriStateCheckbox";
import { newRow, toInputs, toRows } from "@/features/stores/ScreensEditor";
import { makeScreen } from "@/test/fixtures";

function Harness() {
  const [value, setValue] = useState<boolean | null>(null);
  return <TriStateCheckbox label="Ceiling suitable" value={value} onChange={setValue} />;
}

describe("TriStateCheckbox", () => {
  it("cycles Unknown → Yes → No → Unknown with aria-checked mixed/true/false", async () => {
    render(<Harness />);
    const box = () => screen.getByRole("checkbox");
    expect(box().getAttribute("aria-checked")).toBe("mixed");
    await userEvent.click(box());
    expect([box().getAttribute("aria-checked"), box().getAttribute("aria-label")]).toEqual(["true", "Ceiling suitable: Yes"]);
    await userEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("false");
    await userEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("mixed");
  });
});

describe("screen rows", () => {
  it("new rows default to Upcoming, a Dolphin screen, wall mount, and carry no id", () => {
    const row = newRow();
    expect(row).toMatchObject({ status: "Upcoming", is_dolphin_screen: true, has_mount: false, has_ceiling_mount: false });
    expect(toInputs([row])[0]).not.toHaveProperty("id");
    expect(toInputs([row])[0]).not.toHaveProperty("key");
  });

  it("existing rows keep their server id", () => {
    expect(toInputs(toRows({ screens: [makeScreen({ id: "keep", venue_id: "V1" })] }))).toEqual([
      expect.objectContaining({ id: "keep", venue_id: "V1" }),
    ]);
  });
});
