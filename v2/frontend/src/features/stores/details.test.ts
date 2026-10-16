import { describe, expect, it } from "vitest";
import { addressChanged, addressLine, detailsErrors, detailsFormFrom, detailsPatch } from "@/features/stores/details";
import { makeStop } from "@/test/fixtures";
import { DEFAULT_SCHEMA_FOR_TESTS as SCHEMA } from "@/test/schema";

describe("store details model", () => {
  const stop = makeStop({ fields: { dma: "ATL", owner_phone: "555-010-0100" } });

  it("fills every schema field and diffs only changes", () => {
    const form = detailsFormFrom(stop, SCHEMA);
    expect(form.fields).toMatchObject({ dma: "ATL", owner_phone: "555-010-0100", venue_code: "" });
    expect(detailsPatch(stop, form, SCHEMA)).toEqual({});
    const edited = { ...form, store_name: " Alpha Market ", fields: { ...form.fields, dma: "MCN", venue_code: "V9" } };
    const patch = detailsPatch(stop, edited, SCHEMA);
    expect(patch).toEqual({ store_name: "Alpha Market", fields: { dma: "MCN", venue_code: "V9" } });
    expect(addressChanged(patch)).toBe(false);
    expect(addressChanged(detailsPatch(stop, { ...form, zip: "30305" }, SCHEMA))).toBe(true);
  });

  it("validates required core fields and schema types like the backend", () => {
    const form = { ...detailsFormFrom(stop, SCHEMA), store_name: " ", addr: "", fields: { owner_email: "nope" } };
    expect(detailsErrors(form, SCHEMA)).toEqual({
      store_name: "Store name is required",
      addr: "Address is required",
      "fields.owner_email": "Owner Email: enter a valid email",
    });
  });

  it("formats an address line", () => {
    expect(addressLine(stop)).toBe("1 Main St, Atlanta, GA 30303");
    expect(addressLine({ addr: "1 Main St", city: "", state: "", zip: "" })).toBe("1 Main St");
  });
});
