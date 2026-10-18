import io
import unittest

from openpyxl import Workbook

from dolphin_tracker.domain.parsing import (
    DMA_ALIASES,
    VENUE_CODE_ALIASES,
    VENUE_TYPE_ALIASES,
    clean_cell,
    normalize_column,
    read_csv_table,
    read_table,
    read_xlsx_table,
)


class CsvParserTests(unittest.TestCase):
    def test_repairs_unquoted_commas_in_address(self):
        rows = read_csv_table(b"address,store_name\n123 Main St, Dallas, TX 75201,Store A\n")
        self.assertEqual(rows, [{"address": "123 Main St, Dallas, TX 75201", "store_name": "Store A"}])

    def test_preserves_quoted_address(self):
        rows = read_csv_table(b'address,store_name\n"123 Main St, Dallas, TX 75201",Store A\n')
        self.assertEqual(rows[0]["address"], "123 Main St, Dallas, TX 75201")
        self.assertEqual(rows[0]["store_name"], "Store A")

    def test_supports_reversed_columns(self):
        rows = read_csv_table(b"store_name,address\nStore A,123 Main St, Dallas, TX 75201\n")
        self.assertEqual(rows[0]["store_name"], "Store A")
        self.assertEqual(rows[0]["address"], "123 Main St, Dallas, TX 75201")

    def test_normalizes_bom_and_header_punctuation(self):
        self.assertEqual(normalize_column("﻿ Address "), "address")
        self.assertEqual(normalize_column("Store Name"), "store_name")

    def test_cleans_missing_values(self):
        self.assertEqual(clean_cell(float("nan")), "")
        self.assertEqual(clean_cell(None), "")
        self.assertEqual(clean_cell(" x "), "x")

    def test_repairs_address_with_store_and_pa_columns(self):
        rows = read_csv_table(b"address,store_name,pa\n123 Main St, Dallas, TX 75201,Store A,North PA\n")
        self.assertEqual(
            rows, [{"address": "123 Main St, Dallas, TX 75201", "store_name": "Store A", "pa": "North PA"}]
        )

    def test_optional_venue_headers_are_supported(self):
        self.assertIn(normalize_column("Venue Type"), VENUE_TYPE_ALIASES)
        self.assertIn(normalize_column("DMA Name"), DMA_ALIASES)
        self.assertIn(normalize_column("Venue Code"), VENUE_CODE_ALIASES)
        rows = read_csv_table(
            b"address,store_name,pa,venue_type,dma,venue_code\n"
            b'"123 Main St, Dallas, TX 75201",Store A,PA 1,Retail,DFW,V-100\n'
        )
        self.assertEqual(rows[0]["venue_type"], "Retail")
        self.assertEqual(rows[0]["dma"], "DFW")
        self.assertEqual(rows[0]["venue_code"], "V-100")

    def test_duplicate_store_names_keep_distinct_uploaded_addresses(self):
        rows = read_csv_table(
            b"address,store_name,pa,venue_code\n"
            b'"8181 W Sam Houston Pkwy S, Houston, TX 77072",Pizza King,PA 1,V-1\n'
            b'"103 Davis Rd, League City, TX 77573",Pizza King,PA 1,V-2\n'
        )
        self.assertEqual(rows[0]["address"], "8181 W Sam Houston Pkwy S, Houston, TX 77072")
        self.assertEqual(rows[1]["address"], "103 Davis Rd, League City, TX 77573")

    def test_skips_blank_lines_and_pads_short_rows(self):
        rows = read_csv_table(b"address,store_name,pa\n\n123 Main St,Store A\n")
        self.assertEqual(rows, [{"address": "123 Main St", "store_name": "Store A", "pa": ""}])

    def test_cp1252_fallback_replaces_undefined_bytes(self):
        undefined = bytes([0x81, 0x8D, 0x8F, 0x90, 0x9D])
        raw = "address,store_name\n1 Main St,Caf\u00e9 ".encode("cp1252") + undefined + b"\n"
        rows = read_csv_table(raw)  # not UTF-8, and those five bytes are undefined in cp1252
        self.assertEqual(rows[0]["address"], "1 Main St")
        self.assertTrue(rows[0]["store_name"].startswith("Caf\u00e9 "))
        self.assertEqual(rows[0]["store_name"][-5:], "\ufffd" * 5)

    def test_blank_csv_header_cells_become_column_n(self):
        rows = read_csv_table(b"address,,###,store_name\n1 Main St,x,y,Store A\n")
        self.assertEqual(rows, [{"address": "1 Main St", "column_2": "x", "column_3": "y", "store_name": "Store A"}])


class XlsxParserTests(unittest.TestCase):
    @staticmethod
    def _workbook(rows):
        workbook = Workbook()
        sheet = workbook.active
        for row in rows:
            sheet.append(row)
        buffer = io.BytesIO()
        workbook.save(buffer)
        return buffer.getvalue()

    def test_reads_first_sheet_with_normalised_headers(self):
        raw = self._workbook(
            [["Store Name", "Address", "Venue Code"], ["Store A", "1 Main St, Dallas, TX", 42], [None, None, None]]
        )
        rows = read_xlsx_table(raw)
        self.assertEqual(rows, [{"store_name": "Store A", "address": "1 Main St, Dallas, TX", "venue_code": "42"}])

    def test_blank_xlsx_header_cells_become_column_n(self):
        rows = read_xlsx_table(self._workbook([["address", None, "  "], ["1 Main St", "x", "y"]]))
        self.assertEqual(rows, [{"address": "1 Main St", "column_2": "x", "column_3": "y"}])

    def test_read_table_dispatches_on_extension(self):
        raw = self._workbook([["address"], ["1 Main St"]])
        self.assertEqual(read_table("sites.XLSX", raw), [{"address": "1 Main St"}])
        self.assertEqual(read_table("sites.csv", b"address\n1 Main St\n"), [{"address": "1 Main St"}])
        with self.assertRaises(ValueError):
            read_table("sites.xls", raw)
