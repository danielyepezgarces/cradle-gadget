# Cradle Wikidata User Gadget & MediaWiki Extension

Cradle is an interactive, schema-based form editor designed to run directly within Wikidata item pages and self-hosted Wikibase installations. It allows users to view, add, modify, or delete statements (claims) on entities in a premium, modern drawer interface, aligned with the Wikimedia design guidelines.

This repository contains both:
1. The **Wikidata Client-side User Gadget** (`CradleInWikidata.js` and `CradleI18n.json`).
2. The **Native MediaWiki Extension** (`CradleWikibase` folder).

---

## ✨ Features

- **Tabbed Interface Selector**:
  - **Formularios Predefinidos**: Loads form templates registered on `Wikidata:Cradle`.
  - **Esquema de Entidad (ShEx)**: Fetches and parses structured EntitySchemas (e.g. `E10`) directly on-wiki.
  - **Esquemas Personalizados**: Decentralized custom templates stored in the user's namespace.
- **Visual Schema Designer**:
  - Drag, design, and edit custom forms visually without writing wikitext.
  - Dynamic autocomplete search for Wikibase properties (PIDs) and option values (QIDs).
  - Configurable hard-validation limits (`hardselect` / fixed options) and suggestions (`softselect` / free suggestions).
- **Real-Time Statement Validation**:
  - Validates statements dynamically against active schemas (required, optional, datatypes, min/max values).
  - Premium visual indicators using native **Wikimedia Codex SVG icons** and adaptive colors.
- **User Space Storage**:
  - Custom schemas are saved directly under `User:<Username>/Cradle` separated by section headings, bypassing admin restrictions.
- **Full Internationalization (i18n)**:
  - Supports English, Spanish, and easily extendable to other languages.

---

## 🚀 Installation

### 1. As a Wikidata User Gadget

To use the tool as a personal user script on Wikidata, add the following line to your [Special:MyPage/common.js](https://www.wikidata.org/wiki/Special:MyPage/common.js):

```javascript
mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.7.4');
```

*(Note: Increment the `version` parameter to bypass cache when updating).*

### 2. As a Native MediaWiki Extension

To install `CradleWikibase` on your local Wikibase Suite or MediaWiki server:

1. Clone or copy the `CradleWikibase` directory into your MediaWiki installation's `extensions/` directory:
   ```bash
   cp -r CradleWikibase /var/www/mediawiki/extensions/
   ```
2. Add the following line to your local configuration file `LocalSettings.php`:
   ```php
   wfLoadExtension( 'CradleWikibase' );
   ```
3. Load the Cradle interface at `Special:Cradle` on your wiki.

---

## 🛠️ Code Structure

- **`CradleInWikidata.js`**: Core client-side gadget logic for Wikidata.
- **`CradleI18n.json`**: Key-value JSON translations catalog for the gadget UI.
- **`CradleWikibase/`**: MediaWiki extension files.
  - `extension.json`: Extension registration metadata.
  - `src/SpecialCradle.php`: PHP definition of the `Special:Cradle` special page.
  - `modules/CradleInWikidata.js`: Extension client-side module, adapted to load local translation JSON and bind directly to the page root.
  - `modules/CradleI18n.json`: Key-value JSON translations catalog for the extension.

---

## 📚 Development Guidelines

Any modifications to the gadget or extension must follow the rules defined in `AGENTS.md`:

1. **Strict i18n**: No hardcoded user-facing strings. Add new translation keys to `CradleI18n.json` and register English fallbacks in the `fallbackMessages` array within JS files.
2. **English Comments**: All source code comments, documentation headers, and commit logs must be written in English.
3. **Casing Preservation**: Remote and file paths must match casing (e.g. `Cradle.git`).
4. **Semantic Versioning**: Bumping the version (`major.minor.patch`) in all relevant scripts and manifests must be done whenever changes are committed.

---

## 👥 Credits

- Originally conceived and written as Cradle (https://cradle.toolforge.org/) by [Magnus Manske](https://meta.wikimedia.org/wiki/User:Magnus_Manske).
- Upgraded and developed by [Daniel Yepez Garces](https://github.com/danielyepezgarces) and [Ismael Olea](https://meta.wikimedia.org/wiki/User:Olea).
