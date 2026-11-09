#!/usr/bin/env python3
"""
Wikidata & Test Wikidata Automatic Gadget Deployer Script
---------------------------------------------------------
Deploys local CradleInWikidata files directly to Wikidata or Test Wikidata user space:
  - stable: User:Danielyepezgarces/Gadget-cradle.js on www.wikidata.org (Production release)
  - beta:   User:Danielyepezgarces/Gadget-cradle-beta.js on www.wikidata.org (Release candidate)
  - dev:    User:Danielyepezgarces/Gadget-cradle-dev.js on test.wikidata.org (Development / Test wiki)

Shared i18n Catalog:
  - User:Danielyepezgarces/Gadget-cradle/i18n.json

Automatically updates version parameter in User:Danielyepezgarces/common.js to bypass browser cache.

Usage:
  python3 deploy_to_wikidata.py [--target-env stable|beta|dev] [--upload-i18n] [--no-commonjs] [--force]

Prerequisites:
  1. Create Bot Passwords at:
     - https://www.wikidata.org/wiki/Special:BotPasswords (for stable/beta)
     - https://test.wikidata.org/wiki/Special:BotPasswords (for dev)
  2. Fill credentials in .env file (WIKIDATA_USERNAME & WIKIDATA_BOT_PASSWORD)
"""

import os
import sys
import re
import json
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


API_URLS = {
    "stable": "https://www.wikidata.org/w/api.php",
    "beta": "https://www.wikidata.org/w/api.php",
    "dev": "https://test.wikidata.org/w/api.php"
}

DOMAINS = {
    "stable": "www.wikidata.org",
    "beta": "www.wikidata.org",
    "dev": "test.wikidata.org"
}

SHARED_I18N_PAGE = "User:Danielyepezgarces/Gadget-cradle/i18n.json"
SHARED_I18N_SUBPAGE_PREFIX = "User:Danielyepezgarces/Gadget-cradle/i18n"

TARGET_PAGES = {
    "stable": {
        "js": "User:Danielyepezgarces/Gadget-cradle.js",
        "css": "User:Danielyepezgarces/Gadget-cradle.css",
        "i18n": SHARED_I18N_PAGE
    },
    "beta": {
        "js": "User:Danielyepezgarces/Gadget-cradle-beta.js",
        "css": "User:Danielyepezgarces/Gadget-cradle-beta.css",
        "i18n": SHARED_I18N_PAGE
    },
    "dev": {
        "js": "User:Danielyepezgarces/Gadget-cradle-dev.js",
        "css": "User:Danielyepezgarces/Gadget-cradle-dev.css",
        "i18n": SHARED_I18N_PAGE
    }
}


def safe_json_response(res):
    try:
        return res.json()
    except Exception:
        print(f"❌ API Error (HTTP {res.status_code}): {res.text[:300]}")
        sys.exit(1)


def get_login_token(session, api_url):
    """Fetches a login token from target MediaWiki API."""
    params = {
        "action": "query",
        "meta": "tokens",
        "type": "login",
        "format": "json"
    }
    res = session.get(api_url, params=params)
    data = safe_json_response(res)
    return data["query"]["tokens"]["logintoken"]


def login_bot(session, api_url, username, bot_password):
    """Authenticates using MediaWiki login action with Bot Password."""
    token = get_login_token(session, api_url)
    params = {
        "action": "login",
        "lgname": username,
        "lgpassword": bot_password,
        "lgtoken": token,
        "format": "json"
    }
    res = session.post(api_url, data=params)
    data = safe_json_response(res)
    if data.get("login", {}).get("result") != "Success":
        raise PermissionError(f"Login failed on {api_url}: {data.get('login', {}).get('reason', 'Unknown error')}")
    print(f"✓ Successfully authenticated as: {data['login']['lgusername']} on {api_url}")


def get_csrf_token(session, api_url):
    """Fetches a CSRF token for editing."""
    params = {
        "action": "query",
        "meta": "tokens",
        "type": "csrf",
        "format": "json"
    }
    res = session.get(api_url, params=params)
    data = safe_json_response(res)
    return data["query"]["tokens"]["csrftoken"]


def get_remote_page_content(session, api_url, title):
    """Fetches existing raw page content from target wiki to avoid duplicate edits."""
    params = {
        "action": "query",
        "prop": "revisions",
        "titles": title,
        "rvslots": "main",
        "rvprop": "content",
        "format": "json"
    }
    res = session.get(api_url, params=params)
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


def update_wikidata_page(session, api_url, title, content, summary):
    """Updates a page on target wiki using action=edit, skipping if unchanged."""
    remote_content = get_remote_page_content(session, api_url, title)
    if remote_content is not None:
        if remote_content.strip() == content.strip():
            print(f"ℹ️ No changes detected in '{title}' — skipping deployment.")
            return

        # For JSON pages, perform semantic JSON equality check to ignore formatting (tabs vs spaces)
        if title.endswith(".json"):
            try:
                remote_obj = json.loads(remote_content)
                local_obj = json.loads(content)
                if remote_obj == local_obj:
                    print(f"ℹ️ No changes detected in '{title}' — skipping deployment.")
                    return
            except Exception:
                pass

    csrf_token = get_csrf_token(session, api_url)
    params = {
        "action": "edit",
        "title": title,
        "text": content,
        "summary": summary,
        "token": csrf_token,
        "format": "json"
    }
    res = session.post(api_url, data=params)
    data = safe_json_response(res)
    if "edit" in data and data["edit"].get("result") == "Success":
        new_revid = data["edit"].get("newrevid", "no change")
        print(f"✓ Successfully updated '{title}'! (Revision ID: {new_revid})")
    else:
        print(f"❌ Failed to edit page '{title}': {data}")


TARGET_FILES = {
    "stable": "CradleInWikidata-stable.js",
    "beta": "CradleInWikidata-beta.js",
    "dev": "CradleInWikidata-dev.js"
}

TARGET_CSS_FILES = {
    "stable": "CradleInWikidata-stable.css",
    "beta": "CradleInWikidata-beta.css",
    "dev": "CradleInWikidata-dev.css"
}

def update_commonjs_loader_version(session, api_url, target_domain, username, target_env, version_str):
    """Updates User:username/common.js on target wiki to load exclusively target_env script."""
    user_base = username.split('@')[0]
    commonjs_title = f"User:{user_base}/common.js"

    target_script_name = TARGET_PAGES[target_env]["js"].split("/")[-1]
    new_loader_line = f'mw.loader.load("//{target_domain}/w/index.php?title=User:{user_base}/{target_script_name}&action=raw&ctype=text/javascript&version={version_str}");'

    new_content = f"""// User:{user_base}/common.js
// Cradle Wikidata Gadget Loader ({target_env.upper()} release on {target_domain})
{new_loader_line}
"""
    update_wikidata_page(session, api_url, commonjs_title, new_content, f"Set loader to {target_script_name} version {version_str} ({target_env})")
    print(f"✓ Updated loader in '{commonjs_title}' on {target_domain} to target '{target_script_name}' (version {version_str}).")


def main():
    load_dotenv(".env")
    current_branch = get_current_git_branch()

    default_env = "dev"
    if current_branch == "stable":
        default_env = "stable"
    elif current_branch == "beta":
        default_env = "beta"
    elif current_branch == "test":
        default_env = "dev"

    parser = argparse.ArgumentParser(description="Deploy Cradle gadget code to Wikidata or Test Wikidata.")
    parser.add_argument("--target-env", choices=["stable", "beta", "dev"], default=default_env, help=f"Target environment: stable, beta (wikidata.org), or dev (test.wikidata.org) (auto-detected: {default_env})")
    parser.add_argument("--upload-i18n", action="store_true", help="Also upload translatewiki translations to target wiki")
    parser.add_argument("--no-commonjs", action="store_false", dest="update_commonjs", help="Skip updating version parameter in user common.js")
    parser.set_defaults(update_commonjs=True)
    parser.add_argument("--force", action="store_true", help="Bypass git branch mismatch safety warnings")
    parser.add_argument("--username", help="Wikidata username or bot account name (e.g. Danielyepezgarces@cradle-deploy)")
    parser.add_argument("--password", help="Bot Password generated at Special:BotPasswords")
    parser.add_argument("--file", help="Path to local JS file to upload (default: environment file)")

    args = parser.parse_args()

    # Safety check: Warn if deploying 'stable' while not on 'stable' branch
    if args.target_env == "stable" and current_branch != "stable" and not args.force:
        print(f"⚠️ SAFETY WARNING: You are currently on git branch '{current_branch}', but trying to deploy to [STABLE] 'User:Danielyepezgarces/Gadget-cradle.js' on www.wikidata.org.")
        confirm = input("Are you sure you want to deploy non-stable code to production? (y/N): ").strip().lower()
        if confirm != "y":
            print("Aborted deployment.")
            sys.exit(0)

    api_url = API_URLS[args.target_env]
    target_domain = DOMAINS[args.target_env]

    # Select environment-specific credentials if available, otherwise fallback
    if args.target_env == "dev":
        username = args.username or os.getenv("TEST_WIKIDATA_USERNAME") or os.getenv("WIKIDATA_USERNAME")
        password = args.password or os.getenv("TEST_WIKIDATA_BOT_PASSWORD") or os.getenv("WIKIDATA_BOT_PASSWORD")
    else:
        username = args.username or os.getenv("WIKIDATA_USERNAME")
        password = args.password or os.getenv("WIKIDATA_BOT_PASSWORD")

    if not username:
        username = input(f"Enter your Username or BotName for {target_domain} (e.g. Danielyepezgarces@cradle-deploy): ").strip()
    if not password:
        import getpass
        password = getpass.getpass(f"Enter Bot Password for {username} on {target_domain}: ").strip()

    local_file = args.file or TARGET_FILES.get(args.target_env, "CradleInWikidata.js")

    if not os.path.exists(local_file):
        print(f"Error: Local file '{local_file}' not found.")
        sys.exit(1)

    with open(local_file, "r", encoding="utf-8") as f:
        js_code = f.read()

    ver_match = re.search(r"Version:\s*([0-9a-zA-Z.-]+)", js_code)
    version_str = ver_match.group(1) if ver_match else "unknown"

    target_js_page = TARGET_PAGES[args.target_env]["js"]
    target_i18n_page = TARGET_PAGES[args.target_env]["i18n"]

    edit_summary = f"Bump version to {version_str}"
    if args.target_env != "stable":
        edit_summary += f" ({args.target_env})"

    print(f"Preparing deployment to [{args.target_env.upper()}] environment on {target_domain}:")
    print(f"  Target Wiki API:  {api_url}")
    print(f"  Active Git Branch:{current_branch or 'unknown'}")
    print(f"  Target JS Page:   {target_js_page}")
    print(f"  Shared i18n Page: {target_i18n_page}")
    print(f"  Version:          {version_str}")
    print(f"  Edit Summary:     '{edit_summary}'")

    session = requests.Session()
    session.headers.update({
        "User-Agent": f"CradleGadgetDeployer/1.0 (https://{target_domain}/wiki/User:Danielyepezgarces; cradle-gadget-bot@{target_domain}) Python-requests/2.31"
    })

    try:
        login_bot(session, api_url, username, password)
        update_wikidata_page(session, api_url, target_js_page, js_code, edit_summary)

        target_css_page = TARGET_PAGES[args.target_env].get("css")
        local_css_file = TARGET_CSS_FILES.get(args.target_env, "CradleInWikidata.css")
        if target_css_page and os.path.exists(local_css_file):
            with open(local_css_file, "r", encoding="utf-8") as f_css:
                css_code = f_css.read()
            update_wikidata_page(session, api_url, target_css_page, css_code, edit_summary)

        if args.upload_i18n:
            print(f"\nDeploying i18n localization files to {target_domain}:")
            tw_dir = "translatewiki"
            if os.path.isdir(tw_dir):
                tw_files = sorted([f for f in os.listdir(tw_dir) if f.endswith(".json") and f != "qqq.json"])
                for tw_file in tw_files:
                    lang_code = tw_file[:-5]
                    lang_subpage = f"{SHARED_I18N_SUBPAGE_PREFIX}/{lang_code}.json"
                    with open(os.path.join(tw_dir, tw_file), "r", encoding="utf-8") as f_lang:
                        lang_content = f_lang.read()
                    update_wikidata_page(session, api_url, lang_subpage, lang_content, f"Update {lang_code} translation via Translatewiki / Cradle (v{version_str})")

        if args.update_commonjs:
            update_commonjs_loader_version(session, api_url, target_domain, username, args.target_env, version_str)

    except Exception as err:
        print(f"❌ Error during deployment: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
