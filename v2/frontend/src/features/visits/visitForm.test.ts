import { describe, expect, it } from "vitest";
import { contactsOf, contactsPatch, formErrors, formFor, toInput, venueNameOf, visitState } from "@/features/visits/visitForm";
import { makeScreen, makeStop } from "@/test/fixtures";
import type { Category } from "@/lib/api/types";

const TREE: Category[] = [
  { name: "Power Issues", subcategories: ["TV Off"] },
  { name: "Stick / Device Issues", subcategories: ["Stick Replaced With"] },
];

describe("visit form", () => {
  const screen = makeScreen({ id: "s1", stick_number: "ST-1", venue_id: "DD_1" });
  const stop = makeStop({ screens: [screen], fields: { cms_name: "D_005_KIOSK" }, installer_name: "Bo" });

  it("prefills the stick, venue name and installer", () => {
    const form = formFor(stop, screen, { installer: "", manager: "Zoe", date: "2026-11-06" });
    expect(form).toMatchObject({ screen_id: "s1", dd_code: "DD_1", stick_number: "ST-1", venue_name: "D_005_KIOSK", installer: "Bo", dolphin_manager: "Zoe" });
    expect(venueNameOf(makeStop({ fields: {} }))).toBe("");
  });

  it("requires the starred fields and the new number for replacements", () => {
    const form = formFor(stop, screen, { installer: "Ann", manager: "", date: "2026-11-06" });
    expect(Object.keys(formErrors(form, TREE)).sort()).toEqual(
      ["category", "dolphin_manager", "kiosk_mode", "latest_apk", "network_type", "subcategory"].sort(),
    );
    const filled = { ...form, dolphin_manager: "Zoe", network_type: "LTE" as const, latest_apk: true, kiosk_mode: false, category: "Stick / Device Issues", subcategory: "Stick Replaced With" };
    expect(formErrors(filled, TREE)).toEqual({ replaced_with: "Enter the new number" });
    expect(formErrors({ ...filled, replaced_with: "ST-9" }, TREE)).toEqual({});
    expect(formErrors({ ...filled, subcategory: "TV Off" }, TREE).subcategory).toBeTruthy();
    expect(toInput({ ...filled, replaced_with: " ST-9 " }, "plan1")).toMatchObject({ replaced_with: "ST-9", route_plan_id: "plan1", latest_apk: true });
    expect(toInput({ ...filled, subcategory: "TV Off", category: "Power Issues", replaced_with: "left over" }, "").replaced_with).toBe("");
  });

  it("sends only the contact fields that changed", () => {
    const store = makeStop({ owner_name: "Sam", onsite_contact_phone: "404" });
    expect(contactsPatch(store, { ...contactsOf(store), owner_name: " Sam ", onsite_contact_name: "Lee" })).toEqual({ onsite_contact_name: "Lee" });
  });

  it("visit state counts sticks visited since the latest plan", () => {
    const screens = [makeScreen({ id: "x" }), makeScreen({ id: "y" })];
    expect(visitState(makeStop({ screens, screen_visits: {}, last_planned_at: "" }))).toBe("none");
    expect(visitState(makeStop({ screens, screen_visits: { x: "2026-11-02" }, last_planned_at: "" }))).toBe("partly");
    expect(visitState(makeStop({ screens, screen_visits: { x: "2026-11-02", y: "2026-11-03" }, last_planned_at: "2026-11-01" }))).toBe("visited");
    expect(visitState(makeStop({ screens, screen_visits: { x: "2026-11-02", y: "2026-11-03" }, last_planned_at: "2026-11-03" }))).toBe("partly");
  });
});
