# Cradle Wikidata User Gadget & MediaWiki Extension Rules

These rules apply to any AI coding agent developing or modifying the Cradle Wikidata User Gadget or the CradleWikibase MediaWiki Extension in this workspace.

## 1. Internationalization (i18n)
- **NO Hardcoded User-Facing Strings**: All alert messages, text labels, input placeholders, user notifications (`mw.notify`), loader text, search status, and generic interface texts must be fully internationalized using `mw.msg('key')`.
- **Translations Registry**:
  - **English Only (Source Language)**: Whenever new interface messages are required, only add the canonical English translation to `translatewiki/en.json` and document it thoroughly with context and parameters in `translatewiki/qqq.json`.
  - **No Manual Non-English Translations**: Do NOT manually add or edit translations in any other language files (such as `es.json` or other locales). Translatewiki.net is the single source of truth for all non-English translations and synchronizes them automatically.
  - **English Fallbacks in Gadget**: Always register the English translation in the local `fallbackMessages` dictionary inside `CradleInWikidata.js` (both the gadget and the extension versions) so that if the wiki fails to fetch the raw JSON from user space, the interface still loads with correct English fallbacks.

## 2. Coding Standards & Comments
- **Comments in English**: All inline source code comments, documentation headers, and git commit descriptions must be written in English.
- **Maintain Casing**: Keep remote paths and file paths properly matching casing (e.g. `Cradle.git` instead of lowercase `cradle.git`).
- **Semantic Versioning**: Bumping the version (`major.minor.patch`) must be done in all relevant files (`CradleInWikidata.js`, `CradleWikibase/modules/CradleInWikidata.js`, `CradleWikibase/extension.json`) whenever a new feature, refinement, or bugfix is implemented.

## 3. UI Design & Iconography
- **NO Unicode Emojis in User Interface**: Do not use raw unicode emojis (such as 🌐, 📝, 🗣️, 📅, 🔢, 📍, 🔗, ⚠️, 🛠️, 🔀, 🚀, 💬, 🔍) in any UI components, labels, select options, or notification messages. Emojis break Wikimedia visual consistency.
- **Use Codex & OOUI Icons**: Always use clean MediaWiki Codex icons (e.g., `cdx-icon`, standard SVG icons, or the `ICONS` object) for buttons, badges, selectors, alerts, and notifications to maintain a clean, professional Wikimedia look and feel.

## 4. Deployment & Target Environments
- **Separate Environment Deployments**: Do NOT deploy to the `dev` environment (`--target-env dev`) when performing a `stable` environment deployment (`--target-env stable`), unless the user explicitly requests deploying to both environments. Keep deployment targets strictly separated.

