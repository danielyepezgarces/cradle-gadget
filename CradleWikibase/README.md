# CradleWikibase MediaWiki Extension

`CradleWikibase` is a native MediaWiki extension that packages Cradle's visual schema designer and form editing interface into a native wiki special page (`Special:Cradle`). It is optimized for self-hosted Wikibase Suite repositories and private/institutional instances.

## 📋 Requirements

- MediaWiki 1.39+
- Wikibase Repository extension installed and configured.

---

## 🚀 Installation

1. **Copy the directory**: Place the `CradleWikibase` folder inside the `extensions/` directory of your MediaWiki installation:
   ```bash
   cp -r CradleWikibase /var/www/html/w/extensions/
   ```

2. **Enable the extension**: Add the following line to the bottom of your `LocalSettings.php` file:
   ```php
   wfLoadExtension( 'CradleWikibase' );
   ```

3. **Verify Installation**: Navigate to `Special:Version` on your wiki. You should see `CradleWikibase` listed under the active extensions.

---

## ⚙️ How it Works

- **PHP Controller (`src/SpecialCradle.php`)**: Registers the special page `Special:Cradle` and outputs the main structural container `#cradle-root`.
- **ResourceLoader Integration**: 
  - Automatically loads the client-side JavaScript module (`modules/CradleInWikidata.js`).
  - Pre-fetches the local translation catalog (`modules/CradleI18n.json`) and registers them dynamically as MediaWiki translation messages in the client.
- **Wikibase API Binding**: Calls to Wikibase are executed locally via `/w/api.php` relative paths, ensuring complete isolation and compatibility with self-hosted entities without hardcoding external domain URLs.
