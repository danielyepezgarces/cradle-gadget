# Cradle Wikidata User Gadget

Cradle is a modern, schema-guided form editor that brings structured data editing and creation directly into Wikidata item pages and `Special:Cradle`. Instead of manually navigating property by property, Cradle provides a focused sidebar drawer and standalone creation workflow guided by W3C Shape Expressions (ShEx) and EntitySchemas (`EntitySchema:E...`).

Inspired by the original [Cradle tool](https://cradle.toolforge.org/) by Magnus Manske, this user gadget is designed for Wikimedia contributors who want faster, consistent, high-quality editing aligned with community schemas.

---

## 🚀 Installation

To use Cradle on Wikidata, add the following line to your personal [common.js](https://www.wikidata.org/wiki/Special:MyPage/common.js) page:

```javascript
mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.40.0');
```

*(You can increment the `version` parameter at the end of the URL to bypass browser cache whenever a new release is published).*

---

## ✨ Key Features

1. **In-Context Drawer Editor**: Adds an *Edit with Cradle* button on Wikidata item pages, opening a modern, non-destructive sidebar drawer to inspect, edit, add, or remove statements in place.
2. **Automatic Schema Discovery**: Automatically detects linked EntitySchemas (via Property P12861) on the item itself, its classes (`P31` instance of, `P279` subclass of), and occupation hierarchies (`P106` for human items).
3. **Full ShEx EntitySchema Support**: Direct search, loading, and real-time validation against native Wikidata EntitySchemas (`namespace 640`).
4. **Visual Schema Designer & ShEx Generator**: Interactive visual builder to create new ShEx EntitySchemas without manual coding. Supports custom DataTypes, Cardinalities (`1`, `?`, `+`, `*`), OR Groups, Geo-literals, Sub-shapes / Derivations (e.g. extending E10 for Q5), and auto-generated `IMPORT` statements.
5. **1-Click Export & Publishing**: Export valid ShEx with rich syntax highlighting or publish directly to `Special:NewEntitySchema`.
6. **Qualifiers, Ranks & References**: Comprehensive statement editing including snaks, ranks (preferred, normal, deprecated), qualifiers, and references.
7. **Citoid Integration**: Automatic reference metadata extraction via Wikimedia Citoid REST API from URLs, DOIs, ISBNs, and PMIDs.
8. **Live Quality Constraints (WBQC)**: Evaluates input values against Wikidata Property Constraints in real-time, displaying warning badges and suggestions.
9. **Full 23 Wikibase Datatypes**: Support for items, properties, strings, monolingual text, dates/times, quantities, URLs, Commons media, coordinates, external identifiers, and more.
10. **Wikimedia Codex & 100% i18n**: Adheres to Wikimedia Codex UI guidelines, using official Codex SVG icons (no raw emojis) and full internationalization (`CradleI18n.json`).

---

## 🛠️ Automated Deployment

This repository includes `deploy_to_wikidata.py` to deploy script updates and i18n catalogs directly to Wikidata user space:

```bash
# Copy and configure your bot credentials
cp .env.example .env

# Deploy to production (stable)
python3 deploy_to_wikidata.py --target-env stable --upload-i18n
```

---

## 👥 Credits & License

- Based on [Cradle](https://cradle.toolforge.org/) by [Magnus Manske](https://meta.wikimedia.org/wiki/User:Magnus_Manske).
- Developed and maintained by [Daniel Yepez Garces](https://github.com/danielyepezgarces) and [Ismael Olea](https://meta.wikimedia.org/wiki/User:Olea).
- License: [MIT](https://opensource.org/licenses/MIT).
