# Cradle Wikidata User Gadget

## About Cradle

Cradle is a schema-guided form editor that brings structured data entry directly into Wikidata item pages. Instead of navigating the full Wikibase interface property by property, you work inside a focused sidebar that understands what kind of item you are editing and which statements are required, optional, or constrained to specific values. The gadget is inspired by the original [Cradle tool](https://cradle.toolforge.org/) by Magnus Manske and is designed for contributors who want faster, more consistent editing without leaving the item they are working on.

Once installed in your personal JavaScript configuration, Cradle appears on every Wikidata item page as an **Edit with Cradle** button next to the page title. When you open it, the gadget inspects the item's classes and automatically loads any linked EntitySchemas (ShEx). If no schema is detected, you can enter one manually. Each property is rendered as a card with labels, descriptions, datatype-aware inputs, and live validation badges that tell you at a glance whether mandatory fields are satisfied. You can add, modify, or remove statements and save everything back to Wikidata in a single action, with an edit summary that records which schema guided the change.

For creating new items, Cradle provides a dedicated full-page experience at `Special:Cradle`. There you can choose from community predefined forms (`Wikidata:Cradle`), load an EntitySchema by ID, use your own custom templates stored in user space, or search schemas shared by other contributors. A built-in visual designer lets you compose personal form templates without writing ShEx: define mandatory properties, fixed option lists (hardselect), suggested values (softselect), and default QIDs, then save them to `User:<YourUsername>/Cradle` for reuse. All interface text is available in English and Spanish.

---

## Installation

To use this gadget on Wikidata, add the following line to your personal [common.js](https://www.wikidata.org/wiki/Special:MyPage/common.js) page:

```javascript
mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.8.2');
```

*(Always update the `version` parameter at the end of the URL to bypass browser caching when a new release is published.)*

---

## Key Features

1. **In-Context Editor**: Adds an "Edit with Cradle" button next to the main heading of Wikidata item pages, opening a custom editing sidebar.
2. **Automatic Schema Detection**: Reads EntitySchema links (P12861) on the item and on its `instance of` (P31) / `subclass of` (P279) classes.
3. **Visual Designer**: Build custom form templates directly in the UI. Specify mandatory properties, add default values, and set up input constraints.
4. **Flexible Options Autocomplete**:
   - **Hardselect (fixed options)**: Forces the user to select a single predefined QID item.
   - **Softselect (suggestions)**: Provides multiple pre-selected QID options as recommendations, while allowing the user to search and add custom QIDs.
5. **Real-Time Codex Validation**: Form fields automatically change colors and display Wikimedia Codex SVG icons indicating whether properties satisfy the schema requirements.
6. **Three Template Sources**: Predefined community forms, EntitySchema (ShEx), and personal custom schemas in user space.
7. **Community Schema Search**: Discover and load form templates published by other users under `User:*/Cradle`.

---

## Custom Schema Format

Custom templates designed with the visual builder are stored on your personal user page subpage (`User:<Username>/Cradle`). They are saved as standard wiki sections:

```wikitext
== Actor or Film Director ==
; P31 : hardselect:Q5 | mandatory
; P106 : softselect:Q33999,Q2526255
```

When you open the **Custom Schemas** tab, Cradle downloads this page, parses the headers, and displays your forms in the template list.

| Token | Meaning |
|-------|---------|
| `mandatory` | At least one value is required before saving |
| `hardselect:Q1,Q2` | User must pick from the listed QIDs (dropdown) |
| `softselect:Q1,Q2` | Suggested QIDs shown first; free search still allowed |
| `default:Q5` | Pre-filled default value for the property |

Optional per-language labels can be added with lines like `:de:Antike Töpfer`.

---

## Further Documentation

| Document | Audience | Description |
|----------|----------|-------------|
| [GADGET_TECHNICAL.md](GADGET_TECHNICAL.md) | Developers & maintainers | Full requirements list and technical decision record |
| [GADGET_ARCHITECTURE.puml](GADGET_ARCHITECTURE.puml) | Developers & architects | PlantUML component and data-flow diagram |

---

## Credits & License

- Based on [Cradle](https://cradle.toolforge.org/) by [Magnus Manske](https://meta.wikimedia.org/wiki/User:Magnus_Manske).
- Developed and maintained by [Daniel Yepez Garces](https://github.com/danielyepezgarces) and [Ismael Olea](https://meta.wikimedia.org/wiki/User:Olea).
- License: MIT.
