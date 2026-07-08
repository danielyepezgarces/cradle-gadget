# Cradle Wikidata User Gadget

This module is a client-side JavaScript gadget designed to run directly within Wikidata item pages. It detects classes associated with the item, parses the corresponding EntitySchemas (ShEx), and provides an interactive sidebar drawer to edit statements in real-time.

## 🚀 Installation

To use this gadget on Wikidata, add the following line to your personal [common.js](https://www.wikidata.org/wiki/Special:MyPage/common.js) page:

```javascript
mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.7.4');
```

*(Note: Always update the `version` parameter at the end of the URL to bypass browser caching when a new update is released).*

---

## 💡 Key Features

1. **In-Context Editor**: Adds an "Editar con Cradle" button next to the main heading of Wikidata item pages, opening a custom editing sidebar.
2. **Visual Designer**: Build custom form templates directly in the UI. Specify mandatory properties, add default values, and setup input constraints.
3. **Flexible Options Autocomplete**:
   - **Hardselect (Opciones fijas)**: Forces the user to select a single predefined QID item.
   - **Softselect (Sugerencias)**: Provides multiple pre-selected QID options as recommendations, while allowing the user to search and add custom QIDs.
4. **Real-Time Codex Validation**: Form fields automatically change colors and display Wikimedia Codex SVG icons indicating whether properties satisfy the schema requirements.

---

## 💾 Custom Schema Format

Custom templates designed with the visual builder are stored on your personal user page subpage (`User:<Username>/Cradle`). They are saved as standard wiki sections:

```wikitext
== Actor or Film Director ==
; P31 : hardselect:Q5 | mandatory
; P106 : softselect:Q33999,Q2526255
```

When you open the "Esquemas Personalizados" tab, Cradle downloads this page, parses the headers, and displays your forms in the template list.
