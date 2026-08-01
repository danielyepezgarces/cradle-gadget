#!/usr/bin/env python3
"""
Wikidata Automatic Gadget Deployer Script
-----------------------------------------
Deploys local CradleInWikidata.js directly to Wikidata user space:
  - stable: User:Danielyepezgarces/Gadget-cradle.js (Production release)
  - beta:   User:Danielyepezgarces/Gadget-cradle-beta.js (Release candidate)
  - dev:    User:Danielyepezgarces/Gadget-cradle-dev.js (Development / Bleeding edge)

Shared i18n Catalog:
  - User:Danielyepezgarces/Gadget-cradle/i18n.json (Shared by all environments)

Automatically updates version parameter in User:Danielyepezgarces/common.js to bypass browser cache.

Usage:
  python3 deploy_to_wikidata.py [--target-env stable|beta|dev] [--upload-i18n] [--no-commonjs] [--force]

Prerequisites:
  1. Create a Bot Password at https://www.wikidata.org/wiki/Special:BotPasswords
  2. Fill credentials in .env file (WIKIDATA_USERNAME & WIKIDATA_BOT_PASSWORD)
"""

import os
import sys
import re
import argparse
import subprocess
import requests


def load_dotenv(env_path=".env"):
    """Reads .env file and populates os.environ without requiring external packages."""
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    if key and val:
                        os.environ.setdefault(key, val)


def get_current_git_branch():
    """Detects active Git branch name safely."""
    try:
        branch = subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"], stderr=subprocess.DEVNULL).decode("utf-8").strip()
        return branch
    except Exception:
        return None


WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php"
SHARED_I18N_PAGE = "User:Danielyepezgarces/Gadget-cradle/i18n.json"

TARGET_PAGES = {
    "stable": {
        "js": "User:Danielyepezgarces/Gadget-cradle.js",
        "i18n": SHARED_I18N_PAGE
    },
    "beta": {
        "js": "User:Danielyepezgarces/Gadget-cradle-beta.js",
        "i18n": SHARED_I18N_PAGE
    },
    "dev": {
        "js": "User:Danielyepezgarces/Gadget-cradle-dev.js",
        "i18n": SHARED_I18N_PAGE
    }
}


def safe_json_response(res):
    try:
        return res.json()
    except Exception:
        print(f"❌ API Error (HTTP {res.status_code}): {res.text[:300]}")
        sys.exit(1)


def get_login_token(session):
    """Fetches a login token from Wikidata API."""
    params = {
        "action": "query",
        "meta": "tokens",
        "type": "login",
        "format": "json"
    }
    res = session.get(WIKIDATA_API_URL, params=params)
    data = safe_json_response(res)
    return data["query"]["tokens"]["logintoken"]


def login_bot(session, username, bot_password):
    """Authenticates using MediaWiki login action with Bot Password."""
    token = get_login_token(session)
    params = {
        "action": "login",
        "lgname": username,
        "lgpassword": bot_password,
        "lgtoken": token,
        "format": "json"
    }
    res = session.post(WIKIDATA_API_URL, data=params)
    data = safe_json_response(res)
    if data.get("login", {}).get("result") != "Success":
        raise PermissionError(f"Login failed: {data.get('login', {}).get('reason', 'Unknown error')}")
    print(f"✓ Successfully authenticated as: {data['login']['lgusername']}")


def get_csrf_token(session):
    """Fetches a CSRF token for editing."""
    params = {
        "action": "query",
        "meta": "tokens",
        "type": "csrf",
        "format": "json"
    }
    res = session.get(WIKIDATA_API_URL, params=params)
    data = safe_json_response(res)
    return data["query"]["tokens"]["csrftoken"]


def get_remote_page_content(session, title):
    """Fetches existing raw page content from Wikidata to avoid duplicate edits."""
    params = {
        "action": "query",
        "prop": "revisions",
        "titles": title,
        "rvslots": "main",
        "rvprop": "content",
        "format": "json"
    }
    res = session.get(WIKIDATA_API_URL, params=params)
    data = safe_json_response(res)
    pages = data.get("query", {}).get("pages", {})
    for page_id, page_data in pages.items():
        if page_id == "-1" or "missing" in page_data:
            return None
        revisions = page_data.get("revisions", [])
        if revisions:
            slot = revisions[0].get("slots", {}).get("main", {})
            return slot.get("*", "")
    return None


def update_wikidata_page(session, title, content, summary):
    """Updates a page on Wikidata using action=edit, skipping if unchanged."""
    remote_content = get_remote_page_content(session, title)
    if remote_content is not None and remote_content.strip() == content.strip():
        print(f"ℹ️ No changes detected in '{title}' — skipping deployment.")
        return

    csrf_token = get_csrf_token(session)
    params = {
        "action": "edit",
        "title": title,
        "text": content,
        "summary": summary,
        "token": csrf_token,
        "format": "json"
    }
    res = session.post(WIKIDATA_API_URL, data=params)
    data = safe_json_response(res)
    if "edit" in data and data["edit"].get("result") == "Success":
        new_revid = data["edit"].get("newrevid", "no change")
        print(f"✓ Successfully updated '{title}' on Wikidata! (Revision ID: {new_revid})")
    else:
        print(f"❌ Failed to edit page '{title}': {data}")


def update_commonjs_loader_version(session, username, target_env, version_str):
    """Updates loader line in User:Danielyepezgarces/common.js to point to target_env and version_str."""
    user_base = username.split('@')[0]
    commonjs_title = f"User:{user_base}/common.js"
    content = get_remote_page_content(session, commonjs_title)
    if not content:
        print(f"ℹ️ Could not fetch '{commonjs_title}' to update loader version.")
        return

    target_script_name = TARGET_PAGES[target_env]["js"].split("/")[-1]
    new_loader_line = f'mw.loader.load("https://www.wikidata.org/w/index.php?title=User:{user_base}/{target_script_name}&action=raw&ctype=text/javascript&version={version_str}");'

    pattern = r'mw\.loader\.load\(["\']https://www\.wikidata\.org/w/index\.php\?title=User:[^/]+/Gadget-cradle(?:\w|-)*\.js&action=raw&ctype=text/javascript(?:&version=[^"\']*)?["\']\);?'

    if re.search(pattern, content):
        new_content = re.sub(pattern, new_loader_line, content)
        if new_content != content:
            update_wikidata_page(session, commonjs_title, new_content, f"Switch loader to {target_script_name} version {version_str}")
            print(f"✓ Updated loader in '{commonjs_title}' to target '{target_script_name}' (version {version_str}).")
        else:
            print(f"ℹ️ Loader in '{commonjs_title}' is already pointing to '{target_script_name}' ({version_str}).")
    else:
        # Append loader line if not present
        new_content = content.rstrip() + "\n\n" + new_loader_line + "\n"
        update_wikidata_page(session, commonjs_title, new_content, f"Add {target_script_name} loader ({version_str})")
        print(f"✓ Added loader line for '{target_script_name}' ({version_str}) to '{commonjs_title}'.")


def main():
    load_dotenv(".env")
    current_branch = get_current_git_branch()

    default_env = "dev"
    if current_branch == "stable":
        default_env = "stable"
    elif current_branch == "beta":
        default_env = "beta"

    parser = argparse.ArgumentParser(description="Deploy Cradle gadget code to Wikidata.")
    parser.add_argument("--target-env", choices=["stable", "beta", "dev"], default=default_env, help=f"Target environment: stable, beta, or dev (auto-detected: {default_env})")
    parser.add_argument("--upload-i18n", action="store_true", help="Also upload CradleI18n.json to Wikidata")
    parser.add_argument("--no-commonjs", action="store_false", dest="update_commonjs", help="Skip updating version parameter in user common.js")
    parser.set_defaults(update_commonjs=True)
    parser.add_argument("--force", action="store_true", help="Bypass git branch mismatch safety warnings")
    parser.add_argument("--username", help="Wikidata username or bot account name (e.g. Danielyepezgarces@cradle-deploy)")
    parser.add_argument("--password", help="Bot Password generated at Special:BotPasswords")
    parser.add_argument("--file", default="CradleInWikidata.js", help="Path to local JS file to upload")

    args = parser.parse_args()

    # Safety check: Warn if deploying 'stable' while on 'master' branch
    if args.target_env == "stable" and current_branch != "stable" and not args.force:
        print(f"⚠️ SAFETY WARNING: You are currently on git branch '{current_branch}', but trying to deploy to [STABLE] 'User:Danielyepezgarces/Gadget-cradle.js'.")
        confirm = input("Are you sure you want to deploy non-stable code to production? (y/N): ").strip().lower()
        if confirm != "y":
            print("Aborted deployment.")
            sys.exit(0)

    username = args.username or os.getenv("WIKIDATA_USERNAME")
    password = args.password or os.getenv("WIKIDATA_BOT_PASSWORD")

    if not username:
        username = input("Enter your Wikidata Username or BotName (e.g. Danielyepezgarces@cradle-deploy): ").strip()
    if not password:
        import getpass
        password = getpass.getpass("Enter your Bot Password: ").strip()

    if not os.path.exists(args.file):
        print(f"Error: Local file '{args.file}' not found.")
        sys.exit(1)

    with open(args.file, "r", encoding="utf-8") as f:
        js_code = f.read()

    ver_match = re.search(r"Version:\s*([0-9a-zA-Z.-]+)", js_code)
    version_str = ver_match.group(1) if ver_match else "unknown"

    target_js_page = TARGET_PAGES[args.target_env]["js"]
    target_i18n_page = TARGET_PAGES[args.target_env]["i18n"]

    edit_summary = f"Bump version to {version_str}"
    if args.target_env != "stable":
        edit_summary += f" ({args.target_env})"

    print(f"Preparing deployment to Wikidata [{args.target_env.upper()}] environment:")
    print(f"  Active Git Branch: {current_branch or 'unknown'}")
    print(f"  Target JS Page:   {target_js_page}")
    print(f"  Shared i18n Page: {target_i18n_page}")
    print(f"  Version:          {version_str}")
    print(f"  Edit Summary:     '{edit_summary}'")

    session = requests.Session()
    session.headers.update({
        "User-Agent": "CradleGadgetDeployer/1.0 (https://www.wikidata.org/wiki/User:Danielyepezgarces; cradle-gadget-bot@wikidata.org) Python-requests/2.31"
    })

    try:
        login_bot(session, username, password)
        update_wikidata_page(session, target_js_page, js_code, edit_summary)

        if args.upload_i18n and os.path.exists("CradleI18n.json"):
            with open("CradleI18n.json", "r", encoding="utf-8") as f_i18n:
                i18n_code = f_i18n.read()
            update_wikidata_page(session, target_i18n_page, i18n_code, edit_summary)

        if args.update_commonjs:
            update_commonjs_loader_version(session, username, args.target_env, version_str)

    except Exception as err:
        print(f"❌ Error during deployment: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
