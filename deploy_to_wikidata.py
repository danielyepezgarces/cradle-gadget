#!/usr/bin/env python3
"""
Wikidata Automatic Gadget Deployer Script
-----------------------------------------
Deploys local CradleInWikidata.js directly to Wikidata user space:
  - stable: User:Danielyepezgarces/Gadget-cradle.js (Production release)
  - beta:   User:Danielyepezgarces/Gadget-cradle-beta.js (Release candidate)
  - dev:    User:Danielyepezgarces/Gadget-cradle-dev.js (Development / Bleeding edge)

Usage:
  python3 deploy_to_wikidata.py [--target-env stable|beta|dev] [--upload-i18n]

Prerequisites:
  1. Create a Bot Password at https://www.wikidata.org/wiki/Special:BotPasswords
  2. Fill credentials in .env file (WIKIDATA_USERNAME & WIKIDATA_BOT_PASSWORD)
"""

import os
import sys
import re
import argparse
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


WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php"

TARGET_PAGES = {
    "stable": {
        "js": "User:Danielyepezgarces/Gadget-cradle.js",
        "i18n": "User:Danielyepezgarces/Gadget-cradle/i18n.json"
    },
    "beta": {
        "js": "User:Danielyepezgarces/Gadget-cradle-beta.js",
        "i18n": "User:Danielyepezgarces/Gadget-cradle-beta/i18n.json"
    },
    "dev": {
        "js": "User:Danielyepezgarces/Gadget-cradle-dev.js",
        "i18n": "User:Danielyepezgarces/Gadget-cradle-dev/i18n.json"
    }
}


def get_login_token(session):
    """Fetches a login token from Wikidata API."""
    params = {
        "action": "query",
        "meta": "tokens",
        "type": "login",
        "format": "json"
    }
    res = session.get(WIKIDATA_API_URL, params=params).json()
    return res["query"]["tokens"]["logintoken"]


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
    res = session.post(WIKIDATA_API_URL, data=params).json()
    if res.get("login", {}).get("result") != "Success":
        raise PermissionError(f"Login failed: {res.get('login', {}).get('reason', 'Unknown error')}")
    print(f"✓ Successfully authenticated as: {res['login']['lgusername']}")


def get_csrf_token(session):
    """Fetches a CSRF token for editing."""
    params = {
        "action": "query",
        "meta": "tokens",
        "type": "csrf",
        "format": "json"
    }
    res = session.get(WIKIDATA_API_URL, params=params).json()
    return res["query"]["tokens"]["csrftoken"]


def update_wikidata_page(session, title, content, summary):
    """Updates a page on Wikidata using action=edit."""
    csrf_token = get_csrf_token(session)
    params = {
        "action": "edit",
        "title": title,
        "text": content,
        "summary": summary,
        "token": csrf_token,
        "format": "json"
    }
    res = session.post(WIKIDATA_API_URL, data=params).json()
    if "edit" in res and res["edit"].get("result") == "Success":
        new_revid = res["edit"].get("newrevid", "no change")
        print(f"✓ Successfully updated '{title}' on Wikidata! (Revision ID: {new_revid})")
    else:
        print(f"❌ Failed to edit page '{title}': {res}")


def main():
    load_dotenv(".env")

    parser = argparse.ArgumentParser(description="Deploy Cradle gadget code to Wikidata.")
    parser.add_argument("--target-env", choices=["stable", "beta", "dev"], default="dev", help="Target environment: stable, beta, or dev (default: dev)")
    parser.add_argument("--upload-i18n", action="store_true", help="Also upload CradleI18n.json to Wikidata")
    parser.add_argument("--username", help="Wikidata username or bot account name (e.g. Danielyepezgarces@cradle_bot)")
    parser.add_argument("--password", help="Bot Password generated at Special:BotPasswords")
    parser.add_argument("--file", default="CradleInWikidata.js", help="Path to local JS file to upload")

    args = parser.parse_args()

    username = args.username or os.getenv("WIKIDATA_USERNAME")
    password = args.password or os.getenv("WIKIDATA_BOT_PASSWORD")

    if not username or username == "Danielyepezgarces":
        username = input("Enter your Wikidata Username or BotName (e.g. Danielyepezgarces@bot_name): ").strip()
    if not password:
        import getpass
        password = getpass.getpass("Enter your Bot Password: ").strip()

    if not os.path.exists(args.file):
        print(f"Error: Local file '{args.file}' not found.")
        sys.exit(1)

    with open(args.file, "r", encoding="utf-8") as f:
        js_code = f.read()

    ver_match = re.search(r"Version:\s*([0-9.]+)", js_code)
    version_str = ver_match.group(1) if ver_match else "unknown"

    target_js_page = TARGET_PAGES[args.target_env]["js"]
    target_i18n_page = TARGET_PAGES[args.target_env]["i18n"]

    edit_summary = f"Bump version to {version_str}"
    if args.target_env != "stable":
        edit_summary += f" ({args.target_env})"

    print(f"Preparing deployment to Wikidata [{args.target_env.upper()}] environment:")
    print(f"  Target JS Page:   {target_js_page}")
    print(f"  Version:          {version_str}")
    print(f"  Edit Summary:     '{edit_summary}'")

    session = requests.Session()
    session.headers.update({
        "User-Agent": "CradleGadgetDeployer/1.0 (https://www.wikidata.org/wiki/User:Danielyepezgarces)"
    })

    try:
        login_bot(session, username, password)
        update_wikidata_page(session, target_js_page, js_code, edit_summary)

        if args.upload_i18n and os.path.exists("CradleI18n.json"):
            with open("CradleI18n.json", "r", encoding="utf-8") as f_i18n:
                i18n_code = f_i18n.read()
            update_wikidata_page(session, target_i18n_page, i18n_code, edit_summary)

    except Exception as err:
        print(f"❌ Error during deployment: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
