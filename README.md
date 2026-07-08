# Cradle: Wikidata & Wikibase Form Editor

Cradle is an interactive, schema-based form editor that works directly within Wikidata item pages and self-hosted Wikibase installations. It allows users to view, add, modify, or delete claims in a modern sidebar drawer or a dedicated special page, aligned with the Wikimedia design guidelines.

This repository is organized into two separate modules:

1. **Wikidata User Gadget** (Client-side script for `wikidata.org`).
2. **MediaWiki Extension** (Native PHP backend extension for self-hosted wikis).

---

## 📦 Project Modules

### 1. Wikidata User Gadget
A client-side JavaScript gadget designed to be loaded by individual users on Wikidata via their personal JS configuration.
- **Main Files**: `CradleInWikidata.js` and `CradleI18n.json` at the repository root.
- **User guide**: [README_GADGET.md](README_GADGET.md) — installation, features, and custom schema format.
- **Technical spec**: [GADGET_TECHNICAL.md](GADGET_TECHNICAL.md) — requirements and technical decisions.
- **Architecture**: [GADGET_ARCHITECTURE.puml](GADGET_ARCHITECTURE.puml) — PlantUML component diagram.

### 2. MediaWiki Extension (`CradleWikibase`)
A native PHP extension that packages Cradle's logic and registers the native special page `Special:Cradle` on private or institutional Wikibase repositories.
- **Main Folder**: [CradleWikibase/](file:///home/dyepezg/Desarrollo/GLAM-devs/CradleWikibase)
- **Documentation**: See [CradleWikibase/README.md](file:///home/dyepezg/Desarrollo/GLAM-devs/CradleWikibase/README.md) for server requirements, extension registration, and asset configurations.

---

## 🛠️ General Architecture

- **Tabbed Interface Selector**: Integrates predefined templates (from `Wikidata:Cradle`), structured ShEx EntitySchemas, and custom user-space forms into a single visual tab layout.
- **Real-Time Validation**: Statement edits are evaluated dynamically against active schemas. Validation badges next to properties are rendered using **Wikimedia Codex SVG icons** (`check`, `close`, `info`, `alert`) and adapt dynamically to Vector light and dark theme colors.
- **Decentralized Storage**: Custom schemas are saved directly under user namespace subpages (`User:<Username>/Cradle`), allowing any user to manage their custom templates without requiring administrative permissions for the wiki content namespace.

---

## 👥 Credits & License

- Conceived and written as Cradle (https://cradle.toolforge.org/) by [Magnus Manske](https://meta.wikimedia.org/wiki/User:Magnus_Manske).
- Refined, packaged, and maintained by [Daniel Yepez Garces](https://github.com/danielyepezgarces) and [Ismael Olea](https://meta.wikimedia.org/wiki/User:Olea).
- License: MIT.
