# Cradle Wikidata User Gadget — Technical Specification

This document records the functional and non-functional requirements of the Cradle Wikidata User Gadget, together with the technical decisions taken during its design and implementation. It applies to the client-side module delivered as `CradleInWikidata.js` (v1.8.2) and its companion translation catalog `CradleI18n.json`.

---

## 1. Project Requirements

### 1.1 Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | The gadget MUST run exclusively on `wikidata.org` and MUST NOT activate on other wikis when loaded via user JavaScript. |
| FR-02 | On Wikidata item pages (namespace 0), the gadget MUST display an **Edit with Cradle** button adjacent to the page heading (`#firstHeading`). |
| FR-03 | Clicking the edit button MUST open a fixed right-side drawer overlay for in-place statement editing without navigating away from the item. |
| FR-04 | The gadget MUST automatically detect applicable EntitySchemas by reading property **P12861** (*EntitySchema for this class*) on: (a) the current item, and (b) each class linked via **P31** (*instance of*) or **P279** (*subclass of*). |
| FR-05 | When one or more schemas are detected, the gadget MUST load the first detected schema by default; otherwise it MUST prompt the user to enter an EntitySchema ID manually. |
| FR-06 | The gadget MUST fetch EntitySchema content from the `EntitySchema:` namespace, parse the embedded ShEx `schemaText`, and render a form whose fields correspond to the properties declared in the schema's start shape. |
| FR-07 | The gadget MUST support three independent sources of form templates for item creation: (a) predefined community forms from `Wikidata:Cradle`, (b) EntitySchema (ShEx) by ID, and (c) custom user-space schemas stored at `User:<Username>/Cradle`. |
| FR-08 | The gadget MUST provide a full-page creation experience at `Special:Cradle` (implemented as a user subpage redirect on Wikidata) with tabbed access to predefined, ShEx, and custom schema sources. |
| FR-09 | The gadget MUST include a visual Schema Designer that allows logged-in users to compose, edit, and delete custom form templates and persist them as wikitext sections on `User:<Username>/Cradle`. |
| FR-10 | The gadget MUST allow searching community-published schemas in user namespace pages whose titles contain `/Cradle`. |
| FR-11 | For each property in a form, the gadget MUST render datatype-aware inputs supporting at minimum: `wikibase-item`, `monolingualtext`, `quantity`, `time`, `string`, `external-id`, and `url`. |
| FR-12 | For `wikibase-item` properties, the gadget MUST support **hardselect** (fixed dropdown of allowed QIDs) and **softselect** (suggested QIDs with free autocomplete search). |
| FR-13 | The gadget MUST perform live validation against schema cardinality rules (`?`, `*`, `+`, `{n}`, `{n,m}`) and mandatory flags, updating per-property badges and a summary banner in real time as the user types. |
| FR-14 | In edit mode, the gadget MUST pre-populate form fields from the item's existing claims, preserving claim GUIDs for in-place updates and deletions. |
| FR-15 | In create mode, the gadget MUST collect item label (required) and description (optional) in the user's interface language before submission. |
| FR-16 | Saving MUST use the MediaWiki Action API `wbeditentity` endpoint with an edit token; edit summaries MUST be internationalized and reference the active schema or template name. |
| FR-17 | After a successful edit, the page MUST reload; after a successful creation, the browser MUST redirect to the new item page. |
| FR-18 | All user-visible strings MUST be internationalized via `mw.msg()` with support for at least English (`en`) and Spanish (`es`). |
| FR-19 | The gadget MUST add a **Cradle** link to the sidebar toolbox (`p-tb`) pointing to `Special:Cradle` on all Wikidata pages. |

### 1.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | The gadget MUST be deployable as a single JavaScript file loadable via `mw.loader.load()` from a Wikidata user subpage, requiring no server-side installation. |
| NFR-02 | The UI MUST follow Wikimedia design guidelines, using CSS custom properties compatible with Vector skin light and dark themes. |
| NFR-03 | Validation icons MUST use inline SVG paths aligned with Wikimedia Codex iconography (`check`, `close`, `info`, `alert`). |
| NFR-04 | The gadget MUST degrade gracefully when the remote i18n JSON subpage is unreachable, falling back to embedded English (and Spanish for `wgUserLanguage === 'es'`) messages. |
| NFR-05 | API calls MUST use `mw.Api()` to inherit session cookies and CSRF/edit tokens automatically. |
| NFR-06 | Custom schemas MUST be stored in user space so that any logged-in contributor can manage templates without wiki administrator privileges. |
| NFR-07 | Version releases MUST follow semantic versioning (`major.minor.patch`) and MUST be reflected in the script header comment and the cache-busting `version` URL parameter. |
| NFR-08 | Source code comments and commit messages MUST be written in English. |

### 1.3 Out of Scope (Wikidata Gadget)

| Item | Notes |
|------|-------|
| Server-side PHP extension | Covered separately by the `CradleWikibase` MediaWiki extension in this repository. |
| Full ShEx validation engine | Only a lightweight subset parser is implemented; complex ShEx constructs (nested shapes, constraints, SPARQL) are not evaluated at runtime. |
| Qualifiers and references editing | The form editor operates on main snak values (statements) only. |
| Property creation or schema authoring in ShEx syntax | Users may load existing EntitySchemas but cannot author ShEx from within the gadget. |

---

## 2. Technical Decisions

### 2.1 Deployment & Runtime

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **Client-only user gadget** loaded via `common.js` | Zero installation friction for Wikidata contributors; no dependency on site administrators enabling an extension. | MediaWiki extension (requires server access); Toolforge external app (leaves Wikidata context). |
| **Strict wikidata.org guard** at script entry | Prevents accidental execution and API errors on wikis where Wikibase endpoints differ. | Configurable wiki URL (rejected for gadget scope; handled by extension variant). |
| **Cache busting via `version` query parameter** on `mw.loader.load()` URL | MediaWiki ResourceLoader is not available for user scripts; manual version increment is the standard community pattern. | Timestamp-based auto-bust (rejected: harder for users to control). |

### 2.2 Architecture & Code Organization

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **Single IIFE** (`(function(){ 'use strict'; ... })()`) | Encapsulates all state and avoids global namespace pollution on Wikidata. | ES modules via `importScript` (limited MediaWiki support in user scripts). |
| **Module-level mutable state** (`entityData`, `formState`, `schemaProperties`, etc.) | Simplifies a ~3 500-line procedural UI codebase; state is reset on drawer close. | Reactive framework (Vue/React) — rejected due to deployment constraints and bundle size. |
| **jQuery for DOM manipulation** | Available natively on all MediaWiki wikis via `mediawiki.util`; consistent with Wikimedia frontend conventions. | Vanilla DOM API throughout (more verbose without clear benefit here). |
| **Inline CSS injected via `mw.util.addCSS()`** | Keeps a single deployable artifact; CSS uses Vector theme CSS variables for automatic dark-mode support. | External CSS file (requires separate user subpage load). |

### 2.3 Schema Handling

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **Custom lightweight ShEx parser** (`parseShEx()`) | Extracts property IDs, cardinality, and allowed-value lists from the start shape without external dependencies. | Full ShEx.js library (rejected: size, complexity, and partial feature need). |
| **EntitySchema discovery via P12861 traversal** on P31/P279 classes | Matches Wikidata community practice of attaching schemas to classes rather than individual items. | SPARQL query (rejected: extra round-trip and permission complexity). |
| **Three-tier template model** (predefined / ShEx / custom wikitext) | Serves beginners (predefined), schema-aware editors (ShEx), and power users (custom designer). | ShEx-only approach (too steep for casual contributors). |
| **Custom schema wikitext format** (`; P31 : hardselect:Q5 \| mandatory`) | Human-readable, diff-friendly, editable outside the gadget; stored in user space. | JSON blobs in user subpages (less wiki-native). |

### 2.4 Data Access & Persistence

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **`mw.Api()` for all Wikibase operations** | Handles authentication, tokens, and error formatting consistently. | Raw `fetch()` to `/w/api.php` (more boilerplate, manual token management). |
| **`wbeditentity` for both create and edit** | Single endpoint supports claim add/update/remove in one payload. | Individual `wbcreateclaim` / `wbsetclaimvalue` calls (more requests, harder transaction semantics). |
| **Claim GUID tracking in `formState`** | Enables precise update/remove without diffing entire entity on the client. | Full entity replacement (risky for concurrent edits). |
| **`opensearch` API for item autocomplete** | Fast, built-in, returns labels and descriptions without custom search endpoint. | `wbsearchentities` (also viable; opensearch chosen for simplicity with URL-based QID extraction). |
| **Batch property metadata via `wbgetentities`** (max 50 IDs per chunk in designer) | Respects API limits while minimizing round-trips for labels and datatypes. | Individual property lookups per field (N+1 query problem). |

### 2.5 User Interface

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **Sidebar drawer for edit mode; full page for create mode** | Editing is contextual to one item; creation needs broader template selection UI. | Drawer for both modes (rejected: insufficient space for designer and three-tab selector). |
| **`Special:Cradle` via user subpage** on Wikidata | Native special pages require extension install; user subpage provides a stable URL without server changes. | Embed create flow entirely in drawer (current drawer redirects to Special:Cradle). |
| **Early CSS injection to hide default content** on Special:Cradle | Prevents flash of unstyled/default wiki content before JS renders the form container. | Accept FOUC (poor UX on slow connections). |
| **Codex-aligned inline SVG icons** for validation states | Visual consistency with modern Wikimedia UI without loading the full Codex component library. | Unicode emoji indicators (inaccessible, inconsistent across platforms). |

### 2.6 Internationalization

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **Dynamic JSON catalog** fetched from `User:Danielyepezgarces/Gadget-cradle/i18n.json` | Allows translation updates without republishing the main JS file. | Hardcoded strings only (blocks community translation). |
| **Embedded `fallbackMessages` object** in JS | Guarantees English UI if the JSON fetch fails (network error, page deletion). | Fail silently with missing keys (broken UI). |
| **Language merge order**: fallbacks → `en` from JSON → user language from JSON | Ensures partial catalogs still render; user language overrides English. | JSON-only without fallbacks (fragile). |

### 2.7 Supported Datatypes & Value Encoding

| Datatype | Input Widget | API `datavalue` Type |
|----------|-------------|----------------------|
| `wikibase-item` | `<select>` (hardselect/softselect) or autocomplete search | `wikibase-entityid` |
| `monolingualtext` | Language code + text fields | `monolingualtext` |
| `quantity` | `<input type="number">`; amount prefixed with `+` | `quantity` (unit `1`) |
| `time` | Text field (`YYYY`, `YYYY-MM-DD`); auto-expanded to Wikidata time format | `time` (precision inferred from string length) |
| `string`, `external-id`, `url` | Plain text `<input>` | `string` |

---

## 3. Key Source Files

| File | Role |
|------|------|
| `CradleInWikidata.js` | Main gadget script (IIFE): UI, parsers, API integration, designer |
| `CradleI18n.json` | Translation catalog (`en`, `es`) loaded at runtime |
| `e10_schema.shex` | Example ShEx schema (human/E10) for reference and testing |
| `AGENTS.md` | Contributor rules for i18n, comments, and versioning |

---

## 4. External Dependencies (Runtime)

| Dependency | Provided By |
|------------|-------------|
| jQuery (`$`) | MediaWiki core |
| `mw.Api`, `mw.util`, `mw.msg`, `mw.config`, `mw.notify`, `mw.loader` | MediaWiki core / ResourceLoader |
| Wikidata Action API (`/w/api.php`) | Wikidata |
| `Wikidata:Cradle` wiki page | Wikidata community |
| `EntitySchema:` namespace pages | Wikidata EntitySchema extension |
| `User:*/Cradle` subpages | Individual contributors |

---

## 5. Related Documentation

- User guide: [README_GADGET.md](README_GADGET.md)
- Architecture diagram: [GADGET_ARCHITECTURE.puml](GADGET_ARCHITECTURE.puml)
- MediaWiki extension variant: [CradleWikibase/README.md](CradleWikibase/README.md)
