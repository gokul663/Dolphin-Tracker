/** `GET /config/store-fields` as the backend returns it (generated from domain/validation.py; regenerate if it changes). */
import type { StoreFieldSpec } from "@/lib/api/types";

export const STORE_FIELDS_FOR_TESTS: StoreFieldSpec[] = [
  {
    "name": "external_id",
    "label": "IBC#",
    "group": "Identity & address",
    "kind": "text",
    "editable": false,
    "required": true,
    "options": []
  },
  {
    "name": "store_name",
    "label": "Store name",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": true,
    "options": []
  },
  {
    "name": "addr",
    "label": "Address",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": true,
    "options": []
  },
  {
    "name": "city",
    "label": "City",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "state",
    "label": "State",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "zip",
    "label": "ZIP",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "pa",
    "label": "PA",
    "group": "Identity & address",
    "kind": "text",
    "editable": false,
    "required": false,
    "options": []
  },
  {
    "name": "dma",
    "label": "DMA",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "venue_type",
    "label": "Venue type",
    "group": "Identity & address",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "source_date",
    "label": "Sheet date",
    "group": "Identity & address",
    "kind": "text",
    "editable": false,
    "required": false,
    "options": []
  },
  {
    "name": "onsite_contact_name",
    "label": "On-site contact",
    "group": "Contacts",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "onsite_contact_phone",
    "label": "On-site contact phone",
    "group": "Contacts",
    "kind": "phone",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "owner_name",
    "label": "Store owner",
    "group": "Contacts",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "owner_phone",
    "label": "Store owner phone",
    "group": "Contacts",
    "kind": "phone",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "owner_email",
    "label": "Store owner email",
    "group": "Contacts",
    "kind": "email",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "best_contact_time",
    "label": "Best contact time",
    "group": "Contacts",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "preferred_language",
    "label": "Preferred language",
    "group": "Contacts",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "products_to_avoid",
    "label": "Products / content to avoid",
    "group": "Installation",
    "kind": "multiline",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "store_ssid",
    "label": "Store SSID",
    "group": "WiFi",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "store_ssid_password",
    "label": "Store SSID password",
    "group": "WiFi",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "installation_notes",
    "label": "Installation comments",
    "group": "Installation",
    "kind": "multiline",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "image_url",
    "label": "Pictures (image URL)",
    "group": "Pictures",
    "kind": "url",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "cms_details_added",
    "label": "CMS details added",
    "group": "Installation",
    "kind": "bool",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "outlet_status",
    "label": "Outlet status",
    "group": "Installation",
    "kind": "select",
    "editable": true,
    "required": false,
    "options": [
      "New",
      "Existing"
    ]
  },
  {
    "name": "preferred_area",
    "label": "Preferred area in store",
    "group": "Site notes",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "ceiling_type",
    "label": "Ceiling type",
    "group": "Site notes",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "ceiling_height",
    "label": "Approx. ceiling height",
    "group": "Site notes",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "nearest_power_outlet",
    "label": "Nearest power outlet",
    "group": "Site notes",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "ethernet_route",
    "label": "Ethernet cable route",
    "group": "Site notes",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "blocked_dates_notes",
    "label": "Blocked dates / notes",
    "group": "Site notes",
    "kind": "multiline",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "preferred_install_datetime",
    "label": "Preferred install date/time",
    "group": "Site notes",
    "kind": "text",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "spot_visible",
    "label": "Spot visible from most of store",
    "group": "Site checklist",
    "kind": "tristate",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "power_within_6ft",
    "label": "Power outlet within 6 ft",
    "group": "Site checklist",
    "kind": "tristate",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "ethernet_possible",
    "label": "Ethernet can be run",
    "group": "Site checklist",
    "kind": "tristate",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "low_volume_audio_ok",
    "label": "Low-volume audio acceptable",
    "group": "Site checklist",
    "kind": "tristate",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "ceiling_suitable",
    "label": "Ceiling suitable for mounting",
    "group": "Site checklist",
    "kind": "tristate",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "committed_dolphin_screens",
    "label": "Dolphin screens (committed)",
    "group": "Screens",
    "kind": "int",
    "editable": true,
    "required": false,
    "options": []
  },
  {
    "name": "committed_store_tvs",
    "label": "Store TVs (committed)",
    "group": "Screens",
    "kind": "int",
    "editable": true,
    "required": false,
    "options": []
  }
];
