import { describe, expect, it } from "vitest";
import { coreError, keyFromLabel, moveItem, schemaErrors } from "@/lib/validation/fields";

describe("store name rule (inline edits)", () => {
  it("requires a store name and an address", () => {
    expect(coreError("store_name", "  ")).toBe("Store name is required");
    expect(coreError("addr", "")).toBe("Address is required");
    expect(coreError("store_name", "Alpha")).toBeNull();
  });
});

describe("schema editor helpers", () => {
  it("validates like validate_schema", () => {
    const errors = schemaErrors([
      { key: "Bad Key", label: "x", type: "text", required: false },
      { key: "addr", label: "Address", type: "text", required: false },
      { key: "dup", label: "A", type: "text", required: false },
      { key: "dup", label: "B", type: "text", required: false },
      { key: "choice", label: "Choice", type: "select", required: false, options: [] },
      { key: "nolabel", label: " ", type: "text", required: false },
    ]);
    expect(Object.keys(errors)).toEqual(["0", "1", "3", "4", "5"]);
    expect(errors["1"]).toEqual(["Key 'addr' is reserved"]);
  });

  it("makes unique keys from labels", () => {
    expect(keyFromLabel("Payee Name #", [])).toBe("payee_name");
    expect(keyFromLabel("Payee Name", ["payee_name"])).toBe("payee_name_2");
    expect(keyFromLabel("Owner Phone", [])).toBe("owner_phone_field"); // a store attribute since v2: reserved
    expect(keyFromLabel("2nd contact", [])).toBe("field_2nd_contact");
    expect(keyFromLabel("Status", [])).toBe("status_field");
    expect(keyFromLabel("!!!", [])).toBe("field");
  });

  it("moves items and ignores out-of-range moves", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    const same = ["a", "b"];
    expect(moveItem(same, 0, -1)).toBe(same);
  });
});
