import { describe, expect, it } from "vitest";
import { actualCounts, addressChanged, addressLine, detailsErrors, detailsFormFrom, detailsPatch } from "@/features/stores/details";
import { storeFieldError, urlTokens } from "@/lib/validation/storeFields";
import { makeScreen, makeStop } from "@/test/fixtures";
import { STORE_FIELDS_FOR_TESTS as SPECS } from "@/test/storeFields";

describe("store details model (STORE-MODEL §2)", () => {
  const stop = makeStop({ owner_phone: "555-010-0100", spot_visible: true, committed_store_tvs: 2 });

  it("fills every editable attribute, read-only ones excluded", () => {
    const form = detailsFormFrom(stop, SPECS);
    expect(form).toMatchObject({ store_name: "Alpha Mart", dma: "ATL", owner_phone: "555-010-0100", spot_visible: true });
    expect(form).toMatchObject({ committed_store_tvs: "2", committed_dolphin_screens: "", ceiling_suitable: null, cms_details_added: false });
    expect(form).not.toHaveProperty("external_id");
    expect(form).not.toHaveProperty("pa");
    expect(form).not.toHaveProperty("source_date");
  });

  it("diffs only what changed, in API types", () => {
    const form = detailsFormFrom(stop, SPECS);
    expect(detailsPatch(stop, form, SPECS)).toEqual({});
    const edited = { ...form, store_name: " Alpha Market ", spot_visible: null, committed_dolphin_screens: "3", committed_store_tvs: "" };
    expect(detailsPatch(stop, edited, SPECS)).toEqual({
      store_name: "Alpha Market", spot_visible: null, committed_dolphin_screens: 3, committed_store_tvs: null,
    });
    expect(addressChanged(detailsPatch(stop, edited, SPECS))).toBe(false);
    expect(addressChanged(detailsPatch(stop, { ...form, zip: "30305" }, SPECS))).toBe(true);
  });

  it("validates like the backend registry", () => {
    const form = { ...detailsFormFrom(stop, SPECS), store_name: " ", addr: "", owner_email: "nope", image_url: "a folder", committed_store_tvs: "-1" };
    expect(detailsErrors(form, SPECS)).toEqual({
      store_name: "Store name is required",
      addr: "Address is required",
      owner_email: "Store owner email: enter a valid email",
      image_url: "Pictures (image URL): needs at least one http(s):// link",
      committed_store_tvs: "Store TVs (committed): must be a whole number of 0 or more",
    });
    const phone = SPECS.find((spec) => spec.name === "owner_phone");
    expect(phone && storeFieldError(phone, "(404) 555-0100 x12")).toBeNull();
    expect(phone && storeFieldError(phone, "call me")).toBe("Store owner phone: enter a valid phone number");
  });

  it("finds every link in a raw image URL cell", () => {
    expect(urlTokens("see https://a.test/1.jpg, and http://b.test/2.png.")).toEqual(["https://a.test/1.jpg", "http://b.test/2.png"]);
    expect(urlTokens("drive folder")).toEqual([]);
  });

  it("formats an address line and counts actual screens", () => {
    expect(addressLine(stop)).toBe("1 Main St, Atlanta, GA 30303");
    expect(actualCounts([makeScreen(), makeScreen(), makeScreen({ is_dolphin_screen: false })])).toEqual({ dolphin: 2, tvs: 1 });
  });
});
