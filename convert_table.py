#!/usr/bin/env python3
"""
Convert HTML table from telematic.html to JSON format with German translations
"""

import json
from bs4 import BeautifulSoup
import re


def clean_text(text):
    """Clean and normalize text content"""
    if not text:
        return ""
    # Remove extra whitespace and normalize
    text = re.sub(r'\s+', ' ', text.strip())
    # Remove non-breaking spaces
    text = text.replace('\u00a0', ' ')
    # Remove zero-width spaces and other invisible characters
    text = text.replace('\u200b', '')  # Zero Width Space
    text = text.replace('\u200c', '')  # Zero Width Non-Joiner
    text = text.replace('\u200d', '')  # Zero Width Joiner
    text = text.replace('\ufeff', '')  # Zero Width No-Break Space (BOM)
    return text


def detect_streaming_capability(cell):
    """Detect streaming capability from SVG icons"""
    # Look for SVG elements in the cell
    svg = cell.find('svg')
    if svg:
        # Look for path elements
        paths = svg.find_all('path')
        for path in paths:
            d_attr = path.get('d', '')
            # Check for the specific "X" path that indicates false
            if 'M11.9996 12.7054L18.397 19.1026L19.1023 18.3973L12.705 12L19.1023 5.60268L18.397 4.89734L11.9996 11.2947L5.60232 4.89734L4.89697 5.60268L11.2943 12L4.89697 18.3973L5.60232 19.1026L11.9996 12.7054Z' in d_attr:
                return False
            # Check for checkmark or other paths that might indicate true
            elif d_attr and 'M' in d_attr:
                # If it's not the X path, assume it's a checkmark (true)
                return True

    # Fallback to text content
    text = clean_text(cell.get_text()).lower()
    if 'true' in text or 'ja' in text or 'yes' in text:
        return True
    elif 'false' in text or 'nein' in text or 'no' in text:
        return False

    return None


def parse_html_table(html_file):
    """Parse HTML table and return structured data"""
    with open(html_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    soup = BeautifulSoup(html_content, 'html.parser')
    table = soup.find('table')
    if not table:
        raise ValueError(f"No table found in {html_file}")

    # Extract headers
    headers = []
    thead = table.find('thead')
    if thead:
        header_row = thead.find('tr')
        if header_row:
            for th in header_row.find_all('th'):
                header_text = clean_text(th.get_text())
                headers.append(header_text)

    # Extract data rows
    data = []
    tbody = table.find('tbody')
    if tbody:
        rows = tbody.find_all('tr')
        for row in rows:
            cells = row.find_all('td')
            if len(cells) >= len(headers):
                row_data = {}
                for i, cell in enumerate(cells[:len(headers)]):
                    if i < len(headers):
                        header = headers[i]
                        if header == 'Streamingfähig':
                            # Special handling for streaming capability
                            streaming_value = detect_streaming_capability(cell)
                            row_data[header] = streaming_value
                        else:
                            row_data[header] = clean_text(cell.get_text())
                data.append(row_data)

    return data, headers


def convert_html_tables_to_json(english_file, german_file, output_file):
    """Convert HTML tables from both English and German files to JSON"""

    print(f"Processing {english_file}...")
    english_data, english_headers = parse_html_table(english_file)
    print(f"Found {len(english_data)} rows in English file")

    print(f"Processing {german_file}...")
    german_data, german_headers = parse_html_table(german_file)
    print(f"Found {len(german_data)} rows in German file")

    # Combine data from both files
    combined_data = []
    max_rows = max(len(english_data), len(german_data))

    for i in range(max_rows):
        combined_row = {}

        # Get English data
        english_row = english_data[i] if i < len(english_data) else {}
        german_row = german_data[i] if i < len(german_data) else {}

        # Map fields with both English and German versions
        combined_row['cardata_element'] = english_row.get(
            'CarData item', '')  # English header
        combined_row['cardata_element_de'] = german_row.get(
            'CarData Element', '')  # German header

        combined_row['description'] = english_row.get(
            'Description', '')  # English header
        combined_row['description_de'] = german_row.get(
            'Beschreibung', '')  # German header

        # Take technical identifier from whichever file has it
        combined_row['technical_identifier'] = (
            english_row.get('Technical identifier', '') or  # English header
            german_row.get('Technischer Bezeichner', '')    # German header
        )

        # Same for other common fields
        combined_row['data_type'] = (
            english_row.get('Data type', '') or     # English header
            german_row.get('Datentyp', '')          # German header
        )

        combined_row['typical_value_range'] = (
            english_row.get('Typical value range', '') or   # English header
            german_row.get('Typischer Wertebereich', '')    # German header
        )

        combined_row['unit'] = (
            english_row.get('Unit', '') or          # English header
            german_row.get('Einheit', '')           # German header
        )

        # Use streaming capability from whichever file has better data
        streaming_en = english_row.get('Streamable')        # English header
        streaming_de = german_row.get('Streamingfähig')     # German header

        # Prefer German data if it's a boolean, otherwise use English, otherwise None
        if streaming_de is not None and isinstance(streaming_de, bool):
            combined_row['streaming_capable'] = streaming_de
        elif streaming_en is not None and isinstance(streaming_en, bool):
            combined_row['streaming_capable'] = streaming_en
        elif streaming_de is not None:
            combined_row['streaming_capable'] = streaming_de
        elif streaming_en is not None:
            combined_row['streaming_capable'] = streaming_en
        else:
            combined_row['streaming_capable'] = None

        combined_data.append(combined_row)

        # Progress indicator
        if (i + 1) % 100 == 0:
            print(f"Combined {i + 1} rows...")

    # Save to JSON
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(combined_data, f, ensure_ascii=False, indent=2)

    print(f"Combined {len(combined_data)} rows to JSON")
    print(f"Output saved to: {output_file}")

    return combined_data


if __name__ == "__main__":
    try:
        # Debug: Let's see what headers and first row look like from each file
        print("=== DEBUG: Checking English file ===")
        en_data, en_headers = parse_html_table('telematic.html')
        print(f"English headers: {en_headers}")
        if en_data:
            print(f"First English row: {en_data[0]}")

        print("\n=== DEBUG: Checking German file ===")
        de_data, de_headers = parse_html_table('telematic_de.html')
        print(f"German headers: {de_headers}")
        if de_data:
            print(f"First German row: {de_data[0]}")

        print("\n=== Converting combined data ===")
        data = convert_html_tables_to_json(
            'telematic.html', 'telematic_de.html', 'telematic.json')
        print(f"\nFirst few entries:")
        for i, entry in enumerate(data[:2]):
            print(f"\nEntry {i+1}:")
            for key, value in entry.items():
                print(f"  {key}: {value}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
