import unittest

from backend.file_parser import DMA_ALIASES, VENUE_CODE_ALIASES, VENUE_TYPE_ALIASES, clean_cell, normalize_column, normalize_status, read_csv_table


class CsvParserTests(unittest.TestCase):
    def test_repairs_unquoted_commas_in_address(self):
        table = read_csv_table(
            b"address,store_name\n123 Main St, Dallas, TX 75201,Store A\n"
        )

        self.assertEqual(table.to_dict("records"), [{
            "address": "123 Main St, Dallas, TX 75201",
            "store_name": "Store A",
        }])

    def test_preserves_quoted_address(self):
        table = read_csv_table(
            b'address,store_name\n"123 Main St, Dallas, TX 75201",Store A\n'
        )

        self.assertEqual(table.iloc[0]["address"], "123 Main St, Dallas, TX 75201")
        self.assertEqual(table.iloc[0]["store_name"], "Store A")

    def test_supports_reversed_columns(self):
        table = read_csv_table(
            b"store_name,address\nStore A,123 Main St, Dallas, TX 75201\n"
        )

        self.assertEqual(table.iloc[0]["store_name"], "Store A")
        self.assertEqual(table.iloc[0]["address"], "123 Main St, Dallas, TX 75201")

    def test_normalizes_bom_and_header_punctuation(self):
        self.assertEqual(normalize_column("\ufeff Address "), "address")
        self.assertEqual(normalize_column("Store Name"), "store_name")

    def test_cleans_missing_values(self):
        self.assertEqual(clean_cell(float("nan")), "")

    def test_repairs_address_with_store_and_pa_columns(self):
        table = read_csv_table(
            b"address,store_name,pa\n123 Main St, Dallas, TX 75201,Store A,North PA\n"
        )

        self.assertEqual(table.to_dict("records"), [{
            "address": "123 Main St, Dallas, TX 75201",
            "store_name": "Store A",
            "pa": "North PA",
        }])

    def test_normalizes_allowed_venue_status(self):
        self.assertEqual(normalize_status(" technical issue "), ("Technical Issue", True))
        self.assertEqual(normalize_status(""), ("Incomplete", True))
        self.assertEqual(normalize_status("Finished"), ("Incomplete", False))

    def test_optional_venue_headers_are_supported(self):
        self.assertIn(normalize_column("Venue Type"), VENUE_TYPE_ALIASES)
        self.assertIn(normalize_column("DMA Name"), DMA_ALIASES)
        self.assertIn(normalize_column("Venue Code"), VENUE_CODE_ALIASES)

        table = read_csv_table(
            b'address,store_name,pa,venue_type,dma,venue_code\n'
            b'"123 Main St, Dallas, TX 75201",Store A,PA 1,Retail,DFW,V-100\n'
        )
        self.assertEqual(table.iloc[0]["venue_type"], "Retail")
        self.assertEqual(table.iloc[0]["dma"], "DFW")
        self.assertEqual(table.iloc[0]["venue_code"], "V-100")

    def test_duplicate_store_names_keep_distinct_uploaded_addresses(self):
        table = read_csv_table(
            b'address,store_name,pa,venue_code\n'
            b'"8181 W Sam Houston Pkwy S, Houston, TX 77072",Pizza King,PA 1,V-1\n'
            b'"103 Davis Rd, League City, TX 77573",Pizza King,PA 1,V-2\n'
        )

        self.assertEqual(table.iloc[0]["address"], "8181 W Sam Houston Pkwy S, Houston, TX 77072")
        self.assertEqual(table.iloc[1]["address"], "103 Davis Rd, League City, TX 77573")


if __name__ == "__main__":
    unittest.main()
