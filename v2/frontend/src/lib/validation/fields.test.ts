import { describe, expect, it } from "vitest";
import { coreError, fieldError, keyFromLabel, moveItem, schemaErrors } from "@/lib/validation/fields";
import type { FieldDefInput } from "@/lib/api/types";

const def = (type: NonNullable<FieldDefInput["type"]>, extra: Partial<FieldDefInput> = {}) => ({
  label: "Field", type, required: false, options: [] as string[], ...extra,
});

describe("fieldError (mirrors backend B1)", () => {
  it("applies each type rule like domain/schema.py", () => {
    expect(fieldError(def("phone"), "+1 (555) 010-0100")).toBeNull();
    expect(fieldError(def("phone"), "12345")).toBe("Field: enter a valid phone number");
    expect(fieldError(def("email"), "a@b.co")).toBeNull();
    expect(fieldError(def("email"), "nope@")).toBe("Field: enter a valid email");
    expect(fieldError(def("number"), "2.5")).toBeNull();
    expect(fieldError(def("number"), "two")).toBe("Field: must be a number");
    expect(fieldError(def("select", { options: ["Gold"] }), "Bronze")).toBe("Field: must be one of Gold");
    expect(fieldError(def("date"), "2026-10-16")).toBeNull();
    expect(fieldError(def("date"), "16/10/2026")).toBe("Field: use a YYYY-MM-DD date");
  });

  it("handles blanks and required", () => {
    expect(fieldError(def("phone"), "  ")).toBeNull();
    expect(fieldError(def("text", { required: true }), "")).toBe("Field is required");
    expect(coreError("store_name", " ")).toBe("Store name is required");
    expect(coreError("addr", "1 Main St")).toBeNull();
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
