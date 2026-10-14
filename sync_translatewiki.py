#!/usr/bin/env python3
"""
Sync Translatewiki i18n messages for Cradle.

Provides bidirectional synchronization between the single unified catalog
(CradleI18n.json) used by the Wikidata gadget and the individual per-language
JSON files (translatewiki/<lang>.json + qqq.json) required by Translatewiki.net.

Features:
- Maintains and deduplicates '@metadata.authors' per language and globally.
- Preserves translator credits automatically appended by Translatewiki.
- Generates and updates translatewiki/qqq.json message documentation.
- Syncs both CradleI18n.json and CradleWikibase/modules/CradleI18n.json.
- Provides translation coverage statistics and integrity checks.

Usage:
    python3 sync_translatewiki.py --split     # Export CradleI18n.json -> translatewiki/*.json
    python3 sync_translatewiki.py --merge     # Unify translatewiki/*.json -> CradleI18n.json
    python3 sync_translatewiki.py --check     # Check translation coverage and missing keys
    python3 sync_translatewiki.py --authors   # List all translation authors
"""

import os
import sys
import json
import re
import argparse
from typing import List, Dict, Any, Set, Tuple

DEFAULT_PROJECT_AUTHORS = [
    "Daniel Yepez Garces",
    "Ismael Olea"
]

DEFAULT_I18N_UNIFIED = "CradleI18n.json"
DEFAULT_EXTENSION_I18N = "CradleWikibase/modules/CradleI18n.json"
DEFAULT_TRANSLATEWIKI_DIR = "translatewiki"


def deduplicate_authors(*author_lists) -> List[str]:
    """
    Deduplicates author names case-insensitively while preserving
    clean whitespace and preferred casing.
    """
    seen: Dict[str, str] = {}
    for author_list in author_lists:
        if not author_list:
            continue
        if isinstance(author_list, str):
            author_list = [author_list]
        for author in author_list:
            if not author or not isinstance(author, str):
                continue
            clean = author.strip()
            if not clean:
                continue
            key = clean.lower()
            if key not in seen:
                seen[key] = clean
            else:
                # Keep variant with more capital letters or non-abbreviated form
                curr = seen[key]
                if sum(1 for c in clean if c.isupper()) > sum(1 for c in curr if c.isupper()):
                    seen[key] = clean
    return sorted(seen.values(), key=lambda s: s.lower())


def load_json(filepath: str) -> Dict[str, Any]:
    """Loads a JSON file if it exists, otherwise returns empty dict."""
    if not os.path.isfile(filepath):
        return {}
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error reading JSON from {filepath}: {e}", file=sys.stderr)
        return {}


def save_json(filepath: str, data: Dict[str, Any]) -> None:
    """Saves data to JSON with UTF-8, 2-space indent, and trailing newline."""
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def generate_qqq_description(key: str, en_text: str) -> str:
    """
    Generates standard Translatewiki qqq.json message documentation
    based on message key and English string with parameter detection.
    """
    # Detect parameters like $1, $2, $3, etc.
    params = sorted(list(set(re.findall(r"\$(\d+)", en_text))), key=lambda x: int(x))
    
    # Generic description heuristics based on key naming convention
    k_lower = key.lower()
    desc = ""
    if "error" in k_lower or "err" in k_lower or "invalid" in k_lower:
        desc = f"Error message displayed when an operation or validation fails."
    elif "placeholder" in k_lower:
        desc = f"Input placeholder text hinting expected value format."
    elif "tab" in k_lower:
        desc = f"Tab label in the Cradle interface navigation."
    elif "btn" in k_lower or "button" in k_lower:
        desc = f"Button label."
    elif "success" in k_lower:
        desc = f"Success notification message displayed to the user."
    elif "summary" in k_lower:
        desc = f"Edit summary text used when saving entity claims or schemas."
    elif "title" in k_lower:
        desc = f"Title or section heading."
    elif "desc" in k_lower:
        desc = f"Description or helper text explaining an interface section."
    elif "confirm" in k_lower:
        desc = f"Confirmation dialog prompt."
    elif "loading" in k_lower:
        desc = f"Progress or loading status message."
    else:
        desc = f"Interface message for '{key}'."

    if params:
        desc += "\nParameters:"
        for p in params:
            desc += f"\n* ${p} - Contextual parameter value"
            
    return desc


def split_to_translatewiki(unified_file: str, tw_dir: str) -> None:
    """
    Splits the unified CradleI18n.json into individual translatewiki/<lang>.json
    files and creates/updates translatewiki/qqq.json.
    """
    print(f"Reading unified catalog from: {unified_file}")
    data = load_json(unified_file)
    if not data:
        print(f"Error: Unified file {unified_file} is empty or missing.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(tw_dir, exist_ok=True)
    
    # Extract top-level metadata if present
    root_metadata = data.get("@metadata", {})
    root_authors = root_metadata.get("authors", []) if isinstance(root_metadata, dict) else []

    # Filter out @metadata from language list
    languages = [k for k in data.keys() if k != "@metadata"]
    print(f"Found {len(languages)} language(s): {', '.join(languages)}")

    # Process each language
    for lang in languages:
        lang_data = data[lang]
        if not isinstance(lang_data, dict):
            continue

        target_file = os.path.join(tw_dir, f"{lang}.json")
        existing_tw = load_json(target_file)
        existing_authors = []
        if isinstance(existing_tw.get("@metadata"), dict):
            existing_authors = existing_tw["@metadata"].get("authors", [])

        # Extract authors from language catalog if present
        lang_catalog_authors = []
        if isinstance(lang_data.get("@metadata"), dict):
            lang_catalog_authors = lang_data["@metadata"].get("authors", [])

        # Deduplicate all author sources
        merged_authors = deduplicate_authors(
            DEFAULT_PROJECT_AUTHORS,
            root_authors,
            lang_catalog_authors,
            existing_authors
        )

        out_data: Dict[str, Any] = {
            "@metadata": {
                "authors": merged_authors
            }
        }

        # Add message keys sorted alphabetically (ignoring @metadata)
        msg_keys = sorted([k for k in lang_data.keys() if k != "@metadata"])
        for k in msg_keys:
            out_data[k] = lang_data[k]

        save_json(target_file, out_data)
        print(f"  ✓ Written {target_file} ({len(msg_keys)} messages, {len(merged_authors)} authors)")

    # Build / update qqq.json based on English messages
    en_file = os.path.join(tw_dir, "en.json")
    qqq_file = os.path.join(tw_dir, "qqq.json")
    en_data = load_json(en_file)
    existing_qqq = load_json(qqq_file)

    qqq_authors = deduplicate_authors(
        DEFAULT_PROJECT_AUTHORS,
        root_authors,
        existing_qqq.get("@metadata", {}).get("authors", []) if isinstance(existing_qqq.get("@metadata"), dict) else []
    )

    out_qqq: Dict[str, Any] = {
        "@metadata": {
            "authors": qqq_authors
        }
    }

    en_keys = sorted([k for k in en_data.keys() if k != "@metadata"])
    for k in en_keys:
        if k in existing_qqq and existing_qqq[k] and k != "@metadata":
            out_qqq[k] = existing_qqq[k]
        else:
            out_qqq[k] = generate_qqq_description(k, str(en_data[k]))

    save_json(qqq_file, out_qqq)
    print(f"  ✓ Written {qqq_file} ({len(en_keys)} documented messages)")
    print(f"\nTranslatewiki export complete in directory: {tw_dir}/")


def merge_from_translatewiki(tw_dir: str, unified_file: str, sync_files: List[str] = None) -> None:
    """
    Unifies all translatewiki/<lang>.json files into CradleI18n.json,
    deduplicating and preserving @metadata.authors for each language
    and creating a top-level @metadata with all contributors.
    """
    if not os.path.isdir(tw_dir):
        print(f"Error: Translatewiki directory '{tw_dir}' does not exist.", file=sys.stderr)
        sys.exit(1)

    print(f"Scanning Translatewiki directory: {tw_dir}/")
    existing_unified = load_json(unified_file)
    existing_root_meta = existing_unified.get("@metadata", {})
    existing_global_authors = existing_root_meta.get("authors", []) if isinstance(existing_root_meta, dict) else []

    all_files = sorted(os.listdir(tw_dir))
    lang_files = [f for f in all_files if f.endswith(".json") and f != "qqq.json"]

    if not lang_files:
        print(f"No language JSON files found in '{tw_dir}'.", file=sys.stderr)
        sys.exit(1)

    unified_catalog: Dict[str, Any] = {}
    all_contributors: List[str] = list(existing_global_authors)

    # Process English first to establish canonical key ordering
    if "en.json" in lang_files:
        lang_files.remove("en.json")
        lang_files.insert(0, "en.json")

    for f_name in lang_files:
        lang_code = f_name[:-5]  # strip '.json'
        filepath = os.path.join(tw_dir, f_name)
        file_data = load_json(filepath)

        # Extract file authors
        file_meta = file_data.get("@metadata", {})
        file_authors = file_meta.get("authors", []) if isinstance(file_meta, dict) else []

        # Extract existing authors from unified catalog if present
        existing_lang_data = existing_unified.get(lang_code, {})
        existing_lang_authors = []
        if isinstance(existing_lang_data, dict) and isinstance(existing_lang_data.get("@metadata"), dict):
            existing_lang_authors = existing_lang_data["@metadata"].get("authors", [])

        # Deduplicate authors for this language
        merged_lang_authors = deduplicate_authors(
            DEFAULT_PROJECT_AUTHORS if lang_code in ["en", "es"] else [],
            existing_lang_authors,
            file_authors
        )

        all_contributors.extend(merged_lang_authors)

        # Build clean language dictionary
        lang_dict: Dict[str, Any] = {
            "@metadata": {
                "authors": merged_lang_authors
            }
        }

        # Extract all messages (exclude @metadata)
        msg_keys = sorted([k for k in file_data.keys() if k != "@metadata"])
        for k in msg_keys:
            lang_dict[k] = file_data[k]

        unified_catalog[lang_code] = lang_dict
        print(f"  ✓ Merged {lang_code}: {len(msg_keys)} messages, {len(merged_lang_authors)} authors ({', '.join(merged_lang_authors[:3])}{'...' if len(merged_lang_authors) > 3 else ''})")

    # Global @metadata with all contributors across all languages
    unified_catalog["@metadata"] = {
        "authors": deduplicate_authors(DEFAULT_PROJECT_AUTHORS, all_contributors)
    }

    # Reorder so @metadata is first key in the JSON file
    final_output: Dict[str, Any] = {
        "@metadata": unified_catalog["@metadata"]
    }
    for k in sorted([lang for lang in unified_catalog.keys() if lang != "@metadata"]):
        final_output[k] = unified_catalog[k]

    # Save to primary unified file
    save_json(unified_file, final_output)
    print(f"\n✓ Unified catalog successfully written to: {unified_file}")

    # Sync to extra target files (e.g. MediaWiki extension module)
    if sync_files:
        for sf in sync_files:
            save_json(sf, final_output)
            print(f"✓ Synchronized extension copy: {sf}")

    print(f"\nUnification complete! Total unique contributors: {len(final_output['@metadata']['authors'])}")


def check_coverage(tw_dir: str) -> None:
    """Checks translation coverage against en.json and reports missing keys."""
    en_file = os.path.join(tw_dir, "en.json")
    if not os.path.isfile(en_file):
        print(f"Error: Primary language file '{en_file}' not found.", file=sys.stderr)
        return

    en_data = load_json(en_file)
    en_keys = set(k for k in en_data.keys() if k != "@metadata")
    total_keys = len(en_keys)

    print(f"Primary language (en): {total_keys} messages\n" + "-" * 50)

    for fname in sorted(os.listdir(tw_dir)):
        if not fname.endswith(".json") or fname in ["en.json", "qqq.json"]:
            continue
        lang_code = fname[:-5]
        lang_data = load_json(os.path.join(tw_dir, fname))
        lang_keys = set(k for k in lang_data.keys() if k != "@metadata")

        missing = en_keys - lang_keys
        extra = lang_keys - en_keys
        coverage = (len(lang_keys & en_keys) / total_keys) * 100 if total_keys > 0 else 0

        authors = lang_data.get("@metadata", {}).get("authors", []) if isinstance(lang_data.get("@metadata"), dict) else []
        print(f"[{lang_code}] {len(lang_keys)}/{total_keys} messages ({coverage:.1f}%) | {len(authors)} author(s)")
        if missing:
            print(f"    Missing {len(missing)} key(s): {', '.join(sorted(list(missing))[:5])}{'...' if len(missing) > 5 else ''}")
        if extra:
            print(f"    Obsolete/Extra {len(extra)} key(s): {', '.join(sorted(list(extra))[:5])}")


def print_authors_summary(tw_dir: str, unified_file: str) -> None:
    """Prints a clear summary of translation contributors."""
    data = load_json(unified_file) if os.path.isfile(unified_file) else {}
    global_authors = data.get("@metadata", {}).get("authors", [])

    print("=" * 60)
    print("Cradle i18n Translation Authors & Contributors")
    print("=" * 60)
    print(f"Total Unique Contributors: {len(global_authors)}")
    for a in global_authors:
        print(f"  • {a}")

    print("\nAuthors per Language:")
    languages = [k for k in data.keys() if k != "@metadata"]
    for lang in languages:
        authors = data[lang].get("@metadata", {}).get("authors", [])
        print(f"  [{lang}] ({len(authors)}): {', '.join(authors)}")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Sync Translatewiki i18n messages and authors for Cradle."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--split",
        action="store_true",
        help="Export unified CradleI18n.json into translatewiki/*.json and qqq.json"
    )
    group.add_argument(
        "--merge",
        action="store_true",
        help="Unify translatewiki/*.json into CradleI18n.json (default action)"
    )
    group.add_argument(
        "--check",
        action="store_true",
        help="Check translation coverage and validate missing keys"
    )
    group.add_argument(
        "--authors",
        action="store_true",
        help="Display list of translation contributors"
    )

    parser.add_argument(
        "--dir",
        default=DEFAULT_TRANSLATEWIKI_DIR,
        help=f"Directory for Translatewiki JSON files (default: {DEFAULT_TRANSLATEWIKI_DIR})"
    )
    parser.add_argument(
        "--unified",
        default=DEFAULT_I18N_UNIFIED,
        help=f"Path to unified JSON catalog (default: {DEFAULT_I18N_UNIFIED})"
    )

    args = parser.parse_args()

    sync_targets = [DEFAULT_EXTENSION_I18N] if os.path.exists(os.path.dirname(DEFAULT_EXTENSION_I18N)) else []

    if args.split:
        split_to_translatewiki(args.unified, args.dir)
    elif args.check:
        check_coverage(args.dir)
    elif args.authors:
        print_authors_summary(args.dir, args.unified)
    else:
        # Default action is merge / unify
        merge_from_translatewiki(args.dir, args.unified, sync_targets)


if __name__ == "__main__":
    main()
