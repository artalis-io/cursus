#!/usr/bin/env python3
"""Return a CSV's header row + first N data rows + total row count as JSON.

Parsing untrusted uploads happens here (Python), never in the Node backend.
Usage: sample_table.py <path> [limit]   ->  {"headers":[...],"rows":[[...]],"totalRows":N,"delimiter":","}
"""
import sys, csv, json

def sniff_delimiter(path):
    try:
        with open(path, newline='', encoding='utf-8-sig', errors='replace') as f:
            sample = f.read(4096)
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except Exception:
        return ','

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: sample_table.py <path> [limit]"})); return 2
    path = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    delim = sniff_delimiter(path)
    headers, rows = [], []
    try:
        with open(path, newline='', encoding='utf-8-sig', errors='replace') as f:
            r = csv.reader(f, delimiter=delim)
            for i, row in enumerate(r):
                if i == 0:
                    headers = row
                elif i <= limit:
                    rows.append(row)
                else:
                    break
        with open(path, newline='', encoding='utf-8-sig', errors='replace') as f:
            total = max(0, sum(1 for _ in f) - 1)
    except Exception as e:
        print(json.dumps({"error": str(e)})); return 1
    print(json.dumps({"headers": headers, "rows": rows, "totalRows": total, "delimiter": delim}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
