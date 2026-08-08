/**
 * Cradle - A Wikidata User Gadget
 * 
 * This script provides a Cradle-like form editor directly within Wikidata item pages.
 * It automatically detects EntitySchemas associated with the item's classes (via Property P12861
 * on the item itself or its P31 "instance of" / P279 "subclass of" classes), parses the ShEx schema,
 * and displays a premium, modern drawer interface to add, modify, or delete claims in-place.
 * 
 * Authors: [[User:Danielyepezgarces|Daniel Yepez Garces]], [[User:Olea|Ismael Olea]]
 * Based on: Cradle (https://cradle.toolforge.org/) by [[User:Magnus Manske|Magnus Manske]]
 * License: MIT (https://opensource.org/licenses/MIT)
 * Version: 1.34.0
 * 
 * Installation:
 * Add the following line to your [[Special:MyPage/common.js]] on Wikidata (increment version value to bypass cache):
 * mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.34.0');
 */

(function() {
    'use strict';
    let debugMode = false;
    try {
        debugMode = new URLSearchParams(window.location.search).has('cradledebug');
    } catch (e) {}

    function logDebug(...args) {
        if (debugMode) {
            console.log(...args);
        }
    }

    function logError(...args) {
        if (debugMode) {
            console.error(...args);
        }
    }

    // Verify if we are on Wikidata
    if (!mw.config.get('wgServer').includes('wikidata.org')) {
        return;
    }

    const P12861 = 'P12861'; // EntitySchema for this class
    const P31 = 'P31';       // Instance of
    const P279 = 'P279';     // Subclass of
    const P106 = 'P106';     // Occupation

    let pageName = mw.config.get('wgPageName');
    let isSpecialCradle = (pageName === 'Special:Cradle' || pageName === 'Special:BlankPage/Cradle');
    
    // Inject early hide CSS rules to prevent any default content from flashing before script loads
    if (isSpecialCradle) {
        let style = document.createElement('style');
        style.id = 'cradle-early-hide-style';
        style.innerHTML = '#mw-content-text > *:not(.cradle-fullpage-container) { display: none !important; } #firstHeading { visibility: hidden !important; }';
        document.head.appendChild(style);
    }
    
    let isItemPage = (mw.config.get('wgNamespaceNumber') === 0 && mw.config.get('wbEntityId'));
    let entityId = isItemPage ? mw.config.get('wbEntityId') : null;
    
    // State
    let entityData = null;
    let entityDataPromise = null;
    let detectedSchemas = [];
    let cradleTemplates = {};
    let activeSchema = null;
    let activeTemplate = null;
    let activeMode = isItemPage ? 'edit' : 'create'; // 'edit' or 'create'
    
    let schemaProperties = {};
    let propertyMetadata = {};
    let propertyConstraints = {};
    let customSchemas = {};
    let sortedPropertiesMap = {};
    let sortedPropertiesLoaded = false;

    /**
     * Fetches MediaWiki:Wikibase-SortedProperties from Wikidata to order statements canonically.
     */
    function fetchSortedProperties(callback) {
        if (sortedPropertiesLoaded) {
            if (callback) callback();
            return;
        }
        let api = new mw.Api();
        api.get({
            action: 'query',
            prop: 'revisions',
            titles: 'MediaWiki:Wikibase-SortedProperties',
            rvslots: 'main',
            rvprop: 'content',
            format: 'json'
        }).done(function(res) {
            if (res && res.query && res.query.pages) {
                let pages = res.query.pages;
                let pageId = Object.keys(pages)[0];
                if (pageId && pages[pageId].revisions && pages[pageId].revisions[0]) {
                    let content = pages[pageId].revisions[0].slots.main['*'];
                    let matches = content.match(/P\d+/g) || [];
                    let idx = 0;
                    matches.forEach(pid => {
                        if (!(pid in sortedPropertiesMap)) {
                            sortedPropertiesMap[pid] = idx++;
                        }
                    });
                    sortedPropertiesLoaded = true;
                    logDebug('[Cradle] Loaded ' + idx + ' sorted properties from MediaWiki:Wikibase-SortedProperties');
                }
            }
            if (callback) callback();
        }).fail(function() {
            if (callback) callback();
        });
    }

    /**
     * Ensures MediaWiki:Wikibase-SortedProperties is loaded before executing callback.
     */
    function ensureSortedProperties(callback) {
        if (sortedPropertiesLoaded) {
            if (callback) callback();
        } else {
            fetchSortedProperties(callback);
        }
    }

    /**
     * Fetches missing property frequency recommendations from Recoin API (relative completeness indicator).
     */
    /**
     * Fetches property frequency statistics for an entity class from Recoin API (getbyclassid.php).
     */
    function fetchRecoinData(classQID, callback) {
        let cleanQID = (classQID || '').trim().toUpperCase();
        if (!cleanQID || !/^Q\d+$/i.test(cleanQID)) {
            callback(null);
            return;
        }
        let userLang = mw.config.get('wgUserLanguage') || 'en';
        let url = 'https://recoin.toolforge.org/getbyclassid.php?lang=' + userLang + '&subject=' + cleanQID;
        $.ajax({
            url: url,
            dataType: 'jsonp',
            timeout: 5000
        }).done(function(res) {
            if (res && res.Frequenct_properties && Array.isArray(res.Frequenct_properties)) {
                callback(res);
            } else {
                callback(null);
            }
        }).fail(function() {
            callback(null);
        });
    }

    /**
     * Safely parses EntitySchema ID string (e.g. 'E524') from a datavalue object.
     */
    function parseEntitySchemaID(datavalueObj) {
        if (!datavalueObj) return null;
        let val = datavalueObj.value;
        if (!val) return null;
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && val.id) return val.id;
        return null;
    }

    /**
     * Sorts an array of Property IDs according to MediaWiki:Wikibase-SortedProperties canonical order.
     */
    function sortPropertyIDs(propIds) {
        if (!propIds || !Array.isArray(propIds)) return [];
        return propIds.slice().sort((a, b) => {
            let idxA = (a in sortedPropertiesMap) ? sortedPropertiesMap[a] : 999999;
            let idxB = (b in sortedPropertiesMap) ? sortedPropertiesMap[b] : 999999;
            if (idxA !== idxB) {
                return idxA - idxB;
            }
            let numA = parseInt(a.replace('P', ''), 10) || 0;
            let numB = parseInt(b.replace('P', ''), 10) || 0;
            return numA - numB;
        });
    }
    
    let softselectLabels = {};
    let formState = {}; // propertyId -> Array of { id, guid, value, datatype, isDeleted }
    let userWantsToChangeSchema = false;
    let schemasLoadedPromise = null;

    // Stylesheet aligned with Wikimedia design guidelines & Vector light/dark mode
    const customCSS = `
        /* Heading edit button styled to sit nicely at the right of #firstHeading */
        .cradle-edit-heading-btn {
            float: right;
            font-size: 0.85rem;
            font-weight: normal;
            padding: 4px 12px;
            margin-left: 12px;
            margin-right: 4px;
            background-color: var(--background-color-progressive, #36c);
            color: #ffffff !important;
            border: 1px solid var(--border-color-progressive, #36c);
            border-radius: 2px;
            cursor: pointer;
            transition: background-color 0.1s;
            height: 28px;
            line-height: 18px;
        }
        .cradle-edit-heading-btn:hover {
            background-color: var(--background-color-progressive-hover, #447ff5);
            border-color: var(--border-color-progressive-hover, #447ff5);
        }

        /* Cradle Portlet Button in User Personal Menu (p-personal) & Vector 2022 Dropdown */
        #pt-cradle-create a {
            background-color: #36c;
            color: #ffffff !important;
            border: 1px solid #36c;
            border-radius: 2px;
            padding: 3px 8px;
            font-weight: bold;
            font-size: 0.8rem;
            line-height: 1.3;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            gap: 4px;
            height: 26px;
            box-sizing: border-box;
            margin: 2px 4px;
        }
        #pt-cradle-create a:hover {
            background-color: #447ff5;
            border-color: #447ff5;
            color: #ffffff !important;
        }

        /* Clean contrast when rendered inside Vector dropdowns / mw-user-preferences menu */
        .vector-user-menu #pt-cradle-create a,
        .vector-dropdown #pt-cradle-create a,
        .mw-user-preferences #pt-cradle-create a,
        .vector-menu-content #pt-cradle-create a {
            background-color: transparent !important;
            color: #36c !important;
            border: none !important;
            padding: 6px 12px !important;
            height: auto !important;
            font-weight: bold !important;
        }
        .vector-user-menu #pt-cradle-create a:hover,
        .vector-dropdown #pt-cradle-create a:hover,
        .mw-user-preferences #pt-cradle-create a:hover,
        .vector-menu-content #pt-cradle-create a:hover {
            background-color: #eaf3ff !important;
            color: #1e3f8a !important;
        }

        /* Drawer Overlay */
        .cradle-drawer-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0, 0, 0, 0.25);
            z-index: 10000;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
        }
        .cradle-drawer-overlay.open {
            opacity: 1;
            pointer-events: auto;
        }

        /* Wikimedia-styled flat side panel — 50% Viewport Width Drawer */
        .cradle-drawer {
            position: fixed;
            top: 0;
            right: -55vw;
            width: 50vw;
            min-width: 500px;
            max-width: 95vw;
            height: 100vh;
            background-color: var(--background-color-base, #ffffff);
            border-left: 1px solid var(--border-color-base, #a2a9b1);
            box-shadow: -4px 0 20px rgba(0, 0, 0, 0.25);
            z-index: 10001;
            transition: right 0.25s cubic-bezier(0.2, 0.8, 0.4, 1);
            display: flex;
            flex-direction: column;
            color: var(--color-base, #202122);
            font-family: sans-serif;
            box-sizing: border-box;
        }
        .cradle-drawer * {
            box-sizing: border-box;
        }
        .cradle-drawer.open {
            right: 0;
        }

        /* Header styling */
        .cradle-header {
            padding: 16px 20px;
            background-color: var(--background-color-neutral-subtle, #f8f9fa);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .cradle-title-area {
            display: flex;
            flex-direction: column;
            width: 100%;
        }
        .cradle-title {
            margin: 0;
            font-size: 1.15rem;
            font-weight: bold;
            color: var(--color-base, #202122);
        }
        .cradle-subtitle {
            margin: 2px 0 0 0;
            font-size: 0.8rem;
            color: var(--color-subtle, #54595d);
        }
        
        .cradle-close-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--color-subtle, #54595d);
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: 2px;
            transition: background-color 0.1s;
        }
        .cradle-close-btn:hover {
            background-color: rgba(0, 0, 0, 0.05);
            color: var(--color-base, #202122);
        }

        /* Tabs Panel */
        .cradle-tabs {
            display: flex;
            border-bottom: 1px solid var(--border-color-base, #a2a9b1);
            margin-top: 10px;
            gap: 16px;
            width: 100%;
        }

        /* Select/Community Tab Menu responsive styling */
        .cradle-select-tabs {
            display: flex;
            border-bottom: 1px solid var(--border-color-base, #a2a9b1);
            margin-bottom: 15px;
            gap: 4px;
            width: 100%;
        }
        .cradle-select-tab {
            flex: 1;
            flex-shrink: 1;
            border: none;
            background: none;
            padding: 8px 4px;
            font-size: 0.8rem;
            color: var(--color-subtle, #54595d);
            border-bottom: 3px solid transparent;
            border-radius: 4px 4px 0 0;
            cursor: pointer;
            font-weight: normal;
            transition: all 0.15s;
            box-shadow: none;
            box-sizing: border-box;
            height: auto;
            min-height: 38px;
            text-align: center;
            white-space: normal;
            word-wrap: break-word;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .cradle-select-tab:hover {
            color: var(--color-link, #3366cc);
        }
        .cradle-select-tab.active {
            font-weight: bold;
            color: var(--color-link, #3366cc);
            border-bottom: 3px solid var(--color-link, #3366cc);
        }
        .cradle-tab {
            padding: 8px 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 0.85rem;
            color: var(--color-subtle, #54595d);
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            transition: all 0.15s;
        }
        .cradle-tab:hover {
            color: var(--color-link, #3366cc);
        }
        .cradle-tab.active {
            color: var(--color-link, #3366cc);
            border-bottom-color: var(--color-link, #3366cc);
        }

        /* Content panel */
        .cradle-content {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
            background-color: var(--background-color-base, #ffffff);
        }

        /* Selector panels */
        .cradle-selector-box {
            background-color: var(--background-color-neutral-subtle, #f8f9fa);
            border: 1px solid var(--border-color-base, #a2a9b1);
            border-radius: 2px;
            padding: 16px;
            margin-bottom: 16px;
        }
        
        /* Wikibase exact layout — 2 column flexbox from cradle_desing_test.html */
        .cradle-wikibase-statementgrouplistview {
            width: 100%;
        }

        /* Property Group Boxes — Dynamic Validation States */
        .cradle-wikibase-statementgroupview {
            display: flex;
            flex-direction: row;
            border: 2px solid #c8ccd1;
            margin-bottom: 16px;
            position: relative;
            transition: border-color 0.2s ease, background-color 0.2s ease;
        }

        .cradle-wikibase-statementgroupview.valid {
            border: 2px solid #00af89;
        }

        .cradle-wikibase-statementgroupview.invalid {
            border: 2px solid #d33;
            background-color: rgba(211, 51, 51, 0.02);
        }

        .cradle-wikibase-statementgroupview.optional-present {
            border: 2px solid #36c;
        }

        .cradle-wikibase-statementgroupview.optional-missing {
            border: 2px solid #fc3;
            background-color: #fef8ee;
        }

        .cradle-card-validation-badge {
            display: inline-block;
            margin-right: 4px;
            font-size: 0.9rem;
        }

        /* Left column: property label (160px) */
        .cradle-wikibase-statementgroupview-property {
            width: 160px;
            flex-shrink: 0;
            background: #f8f9fa;
            border-right: 1px solid #c8ccd1;
            padding: 10px;
            box-sizing: border-box;
            align-self: stretch;
        }

        .cradle-wikibase-statementgroupview-property-label {
            word-wrap: break-word;
            font-size: 0.875rem;
            font-weight: bold;
            line-height: 1.3;
        }

        .cradle-wikibase-statementgroupview-property-label a {
            color: #0645ad;
            text-decoration: none;
            font-weight: bold;
        }

        .cradle-wikibase-statementgroupview-property-label a:hover {
            text-decoration: underline;
        }

        .cradle-prop-pid {
            display: block;
            font-size: 0.75rem;
            font-weight: normal;
            color: #54595d;
            margin-top: 2px;
        }

        .cradle-prop-desc {
            display: block;
            font-size: 0.75rem;
            font-weight: normal;
            color: #54595d;
            margin-top: 4px;
        }

        .cradle-card-validation-badge {
            display: none;
        }

        /* Right column: statement list */
        .cradle-wikibase-statementlistview {
            flex: 1;
            min-width: 0;
            background: #ffffff;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        }

        .cradle-wikibase-statementlistview-listview {
            padding: 8px;
        }

        .cradle-wikibase-statementview {
            display: flex;
            flex-direction: row;
            align-items: flex-start;
            margin-bottom: 16px;
            position: relative;
        }

        .cradle-wikibase-statementview:last-child {
            margin-bottom: 0;
        }

        .cradle-wikibase-statementview-rankselector {
            flex-shrink: 0;
            width: 24px;
            margin-right: 8px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            color: #a2a9b1;
            font-size: 0.75rem;
            line-height: 1;
            margin-top: 2px;
        }

        .cradle-wikibase-statementview-rankselector .cradle-rank-up,
        .cradle-wikibase-statementview-rankselector .cradle-rank-down {
            cursor: pointer;
            color: #a2a9b1;
        }
        
        .cradle-wikibase-statementview-rankselector .cradle-rank-circle {
            font-size: 0.85rem;
            margin: 2px 0;
            color: #72777d;
        }

        .cradle-wikibase-statementview-mainsnak-container {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .cradle-wikibase-snakview {
            padding: 2px 0;
        }

        .cradle-wikibase-snakview-value-container {
            min-height: 1.6em;
        }

        .cradle-wikibase-snakview-body {
            width: 100%;
        }

        .cradle-valueview-value input {
            width: 100%;
            box-sizing: border-box;
            padding: 4px 6px;
            border: 1px solid transparent;
            background: #fff;
            color: #202122;
            font-size: 0.875rem;
            font-family: inherit;
            border-radius: 0;
            height: 28px;
        }

        .cradle-valueview-value input:focus {
            border-color: #36c;
            box-shadow: inset 0 0 0 1px #36c;
            outline: none;
        }
        
        /* Qualifiers */
        .cradle-wikibase-qualifiers {
            padding: 4px 8px;
            margin-left: 24px;
            font-size: 0.8rem;
        }
        
        .cradle-qualifier-row {
            display: flex;
            margin-bottom: 4px;
        }
        
        .cradle-qualifier-prop {
            width: 120px;
            color: #0645ad;
        }
        
        .cradle-qualifier-val {
            flex: 1;
            color: #202122;
        }

        /* References */
        .cradle-wikibase-references {
            padding: 8px 12px;
            margin-top: 8px;
            margin-left: 24px;
            background-color: #f8f9fa;
            font-size: 0.8rem;
        }
        
        .cradle-reference-header {
            color: #0645ad;
            cursor: pointer;
            margin-bottom: 8px;
        }

        .cradle-reference-row {
            display: flex;
            margin-bottom: 4px;
        }

        .cradle-reference-prop {
            width: 140px;
            color: #0645ad;
        }

        .cradle-reference-val {
            flex: 1;
            color: #202122;
        }
        
        .cradle-add-reference-link {
            text-align: right;
            font-size: 0.75rem;
            color: #0645ad;
            cursor: pointer;
            margin-top: 8px;
            display: block;
        }
        .cradle-add-reference-link:hover {
            text-decoration: underline;
        }

        .cradle-wikibase-toolbar-container {
            flex-shrink: 0;
            padding-top: 4px;
            margin-left: 8px;
        }

        .cradle-wikibase-toolbar-wrapper {
            background: #eaecf0;
            padding: 4px 10px;
            text-align: right;
            border-top: 1px solid #eaecf0;
        }

        .cradle-addstatement-link {
            font-size: 0.75rem;
            color: #0645ad;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
        }

        .cradle-addstatement-link:hover {
            text-decoration: underline;
        }

        .cradle-field-title {
            font-weight: bold;
            font-size: 0.95rem;
            margin: 0;
            display: flex;
            align-items: center;
        }
        .cradle-field-title a {
            color: var(--color-link, #3366cc);
            text-decoration: none;
            transition: color 0.2s;
        }
        .cradle-field-title a:hover {
            color: var(--color-link-hover, #447ff5);
            text-decoration: underline;
        }
        .cradle-field-required-marker {
            color: var(--color-destructive, #d33);
            margin-left: 4px;
            font-weight: bold;
        }
        .cradle-field-description {
            font-size: 0.8rem;
            color: var(--color-subtle, #54595d);
            margin: 4px 0 12px 0;
        }

        /* Statement Row and Inputs */
        .cradle-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            position: relative;
        }
        .cradle-row.deleted {
            opacity: 0.4;
        }
        .cradle-row.deleted .cradle-input, 
        .cradle-row.deleted .cradle-select {
            text-decoration: line-through;
            pointer-events: none;
        }
        
        .cradle-input {
            flex: 1;
            display: block;
            width: 100%;
            max-width: 100%;
            padding: 6px 8px;
            border-radius: 2px;
            border: 1px solid var(--border-color-base, #a2a9b1);
            background-color: var(--background-color-base, #ffffff);
            color: var(--color-base, #202122);
            font-size: 0.85rem;
            outline: none;
            transition: border-color 0.1s, box-shadow 0.1s;
            height: 36px;
            box-sizing: border-box;
        }
        .cradle-input:focus {
            border-color: var(--border-color-progressive-focus, #36c);
            box-shadow: inset 0 0 0 1px var(--border-color-progressive-focus, #36c);
        }

        .cradle-select {
            flex: 1;
            display: block;
            width: 100%;
            max-width: 100%;
            padding: 6px 8px;
            border-radius: 2px;
            border: 1px solid var(--border-color-base, #a2a9b1);
            background-color: var(--background-color-base, #ffffff);
            color: var(--color-base, #202122);
            font-size: 0.85rem;
            outline: none;
            height: 36px;
            box-sizing: border-box;
        }
        .cradle-select:focus {
            border-color: var(--border-color-progressive-focus, #36c);
        }
        
        .cradle-lang-input {
            width: 75px !important;
            flex-grow: 0 !important;
        }

        /* Card actions */
        .cradle-card-action-bar {
            display: flex;
            justify-content: flex-end;
            margin-top: 4px;
        }
        
        .cradle-btn-text {
            background: none;
            border: none;
            color: var(--color-link, #3366cc);
            font-size: 0.8rem;
            font-weight: bold;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 6px;
            border-radius: 2px;
            transition: background-color 0.1s;
        }
        .cradle-btn-text:hover {
            background-color: rgba(51, 102, 204, 0.05);
            color: var(--color-link-hover, #447ff5);
        }
        
        .cradle-btn-delete {
            background: none;
            border: 1px solid transparent;
            color: var(--color-subtle, #54595d);
            cursor: pointer;
            padding: 6px;
            border-radius: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
            height: 32px;
            width: 32px;
        }
        .cradle-btn-delete:hover {
            color: var(--color-destructive, #d33);
            background-color: rgba(221, 51, 51, 0.05);
            border-color: rgba(221, 51, 51, 0.15);
        }
        .cradle-row.deleted .cradle-btn-delete {
            color: var(--color-progressive, #36c);
        }
        /* Wikibase Quality Constraints (wbqc) status styling */
        .cradle-drawer .wbqc-reports-status {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 0.75rem;
            color: #54595d;
            background-color: #f8f9fa;
            border: 1px solid #c8ccd1;
            border-left: 3px solid #36c;
            border-radius: 2px;
            padding: 3px 8px;
            margin-top: 6px;
            cursor: pointer;
            user-select: none;
            width: fit-content;
            transition: background-color 0.15s;
        }
        .cradle-drawer .wbqc-reports-status:hover {
            background-color: #eaecf0;
            color: #202122;
        }
        .cradle-drawer .wbqc-reports-status-suggestions {
            border-left-color: #36c;
        }
        .cradle-drawer .wbqc-reports-status-warning {
            border-left-color: #edab00;
        }

        /* Autocomplete dropdown list */
        .cradle-autocomplete-wrapper {
            position: relative;
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        
        .cradle-autocomplete-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            width: 100%;
            background-color: var(--background-color-base, #ffffff);
            border: 1px solid var(--border-color-base, #a2a9b1);
            border-radius: 2px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
            z-index: 10002;
            max-height: 200px;
            overflow-y: auto;
            padding: 4px 0;
            margin: 4px 0 0 0;
            list-style: none;
        }
        
        .cradle-autocomplete-row {
            padding: 6px 12px;
            cursor: pointer;
            transition: background-color 0.15s;
            display: flex;
            flex-direction: column;
            color: var(--color-base, #202122);
        }
        .cradle-autocomplete-row:hover {
            background-color: var(--background-color-neutral-subtle, #f8f9fa);
            color: var(--color-link, #3366cc);
        }
        .cradle-autocomplete-row-label {
            font-weight: bold;
            font-size: 0.85rem;
        }
        .cradle-autocomplete-row-desc {
            font-size: 0.75rem;
            color: var(--color-subtle, #54595d);
            margin-top: 1px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* Footer buttons styling with explicit high contrast color */
        .cradle-footer {
            padding: 12px 20px;
            border-top: 1px solid var(--border-color-base, #a2a9b1);
            display: flex;
            flex-direction: column;
            gap: 8px;
            background-color: var(--background-color-neutral-subtle, #f8f9fa);
        }
        
        .cradle-btn-primary {
            flex: 1;
            background-color: var(--background-color-progressive, #36c);
            color: #ffffff !important; /* Forces white text inside blue button */
            border: 1px solid var(--border-color-progressive, #36c);
            padding: 8px 16px;
            border-radius: 2px;
            font-weight: bold;
            cursor: pointer;
            transition: background-color 0.1s, border-color 0.1s;
            font-size: 0.85rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            height: 36px;
            box-sizing: border-box;
        }
        .cradle-btn-primary:hover {
            background-color: var(--background-color-progressive-hover, #447ff5);
            border-color: var(--border-color-progressive-hover, #447ff5);
        }
        .cradle-btn-primary:active {
            background-color: var(--background-color-progressive-active, #2a4b8d);
            border-color: var(--border-color-progressive-active, #2a4b8d);
        }
        .cradle-btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .cradle-btn-secondary {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 8px 16px;
            background-color: var(--background-color-base, #ffffff);
            border: 1px solid var(--border-color-base, #a2a9b1);
            color: var(--color-base, #202122);
            border-radius: 2px;
            font-weight: bold;
            cursor: pointer;
            transition: background-color 0.1s, border-color 0.1s;
            font-size: 0.85rem;
            height: 36px;
            box-sizing: border-box;
        }
        .cradle-btn-secondary svg, .cradle-btn-primary svg {
            width: 18px;
            height: 18px;
            fill: currentColor;
            flex-shrink: 0;
            vertical-align: middle;
        }
        .cradle-btn-secondary:hover {
            background-color: var(--background-color-neutral-subtle, #f8f9fa);
        }
        .cradle-btn-secondary:active {
            background-color: #eaecf0;
        }

        /* Loading Spinner */
        .cradle-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: white;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* Full page Cradle content layout styling */
        .cradle-fullpage-container {
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            font-family: sans-serif;
            color: var(--color-base, #202122);
        }
        .cradle-fullpage-title {
            margin-top: 0;
            font-size: 2rem;
            font-weight: normal;
            border-bottom: 1px solid var(--border-color-base, #a2a9b1);
            padding-bottom: 8px;
        }

        /* Validation UI styling */
        .cradle-validation-title {
            margin-top: 0;
            margin-bottom: 8px;
            font-size: 1.15rem;
            font-weight: bold;
            color: var(--color-base, #202122);
        }
        .cradle-validation-desc {
            font-size: 0.85rem;
            color: var(--color-subtle, #54595d);
            margin-bottom: 16px;
        }
        .cradle-validation-list {
            margin-top: 12px;
            padding-left: 0;
            list-style: none;
        }
        .cradle-validation-item {
            display: flex;
            align-items: center;
            padding: 10px 14px;
            border: 1px solid var(--border-color-base, #a2a9b1);
            border-radius: 2px;
            margin-bottom: 8px;
            background-color: var(--background-color-base, #ffffff);
            font-size: 0.85rem;
        }
        .cradle-validation-item.valid {
            border-left: 4px solid var(--color-success, #00af89);
        }
        .cradle-validation-item.invalid {
            border-left: 4px solid var(--color-destructive, #d33);
            background-color: rgba(211, 51, 51, 0.02);
        }
        .cradle-validation-item.optional-present {
            border-left: 4px solid var(--color-progressive, #36c);
        }
        .cradle-validation-item.optional-missing {
            border-left: 4px solid var(--color-warning, #fc3);
            background-color: var(--background-color-warning-subtle, #fef8ee);
        }
        .cradle-validation-badge {
            font-weight: bold;
            margin-right: 12px;
            font-size: 1.2rem;
        }
        .cradle-card-validation-badge svg {
            width: 18px;
            height: 18px;
            fill: currentColor;
        }
        .cradle-field-card.valid .cradle-card-validation-badge {
            color: var(--color-success, #00af89);
        }
        .cradle-field-card.invalid .cradle-card-validation-badge {
            color: var(--color-destructive, #d33);
        }
        .cradle-field-card.optional-present .cradle-card-validation-badge {
            color: var(--color-progressive, #36c);
        }
        .cradle-field-card.optional-missing .cradle-card-validation-badge {
            color: var(--color-warning, #e69138);
        }
        .cradle-validation-label {
            flex-grow: 1;
            font-weight: bold;
        }
        .cradle-validation-status {
            font-size: 0.8rem;
            color: var(--color-subtle, #54595d);
            padding: 2px 6px;
            border-radius: 2px;
            background-color: var(--background-color-neutral-subtle, #f8f9fa);
            border: 1px solid var(--border-color-base, #a2a9b1);
        }
    `;

    // SVG Icons
    const ICONS = {
        cradle: `<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
        close: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="m4.34 2.93 12.73 12.73-1.41 1.41L2.93 4.34z"/><path d="M17.07 4.34 4.34 17.07l-1.41-1.41L15.66 2.93z"/></svg>`,
        plus: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M11 9V4H9v5H4v2h5v5h2v-5h5V9z"/></svg>`,
        trash: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M17 2h-3.5l-1-1h-5l-1 1H3v2h14zm-12 4v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6zm3 11H6V8h2zm3 0H9V8h2zm3 0h-2V8h2z"/></svg>`,
        undo: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M17.8 8A7.8 7.8 0 0 1 10 15.8c-1.3 0-2.5-.3-3.6-.9l1.5-1.5c.7.4 1.4.6 2.1.6a5.8 5.8 0 1 0 0-11.6c-.9 0-1.7.2-2.5.6H10V5H4v6h6V9H6.9c.8-.9 1.9-1.4 3.1-1.4A7.8 7.8 0 0 1 17.8 8"/></svg>`,
        back: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M19 9H4.414l5.293-5.293-1.414-1.414L1.586 10l6.707 6.707 1.414-1.414L4.414 11H19z"/></svg>`,
        check: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="m8.16 13.9 7.4-8.15 1.5 1.35-8.9 9.8L3.25 12l1.4-1.4z"/></svg>`,
        alert: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M11.53 2.3A1.85 1.85 0 0 0 10 1.25 1.85 1.85 0 0 0 8.47 2.3L1.31 14.73A1.82 1.82 0 0 0 1.3 16.5a1.76 1.76 0 0 0 1.54.85h14.32a1.76 1.76 0 0 0 1.54-.85 1.82 1.82 0 0 0 0-1.77ZM11 15H9v-2h2Zm0-4H9V6h2z"/></svg>`,
        info: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M10 0a10 10 0 1 0 10 10A10 10 0 0 0 10 0m1 15H9v-6h2Zm0-8H9V5h2z"/></svg>`,
        download: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M17 12v5H3v-5H1v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5z"/><path d="M10 15l5-6h-3V1H8v8H5z"/></svg>`,
        external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`
    };

    /**
     * Initializes the gadget and loads i18n messages dynamically from a subpage.
     */
    function init() {
        let userLang = mw.config.get('wgUserLanguage') || 'en';

        // Local fallback messages to ensure script functionality even if network request fails
        const fallbackMessages = {
            'cradle-editor': 'Cradle Editor',
            'cradle-edit-tab': 'Edit Current Item',
            'cradle-create-tab': 'Create New Item',
            'cradle-subtitle': 'Modify entity claims using schemas',
            'cradle-change-form': 'Change Schema',
            'cradle-new-item-identity': 'New Item Identity',
            'cradle-new-item-identity-desc': 'Provide the label, description, and aliases in one or more languages.',
            'cradle-new-item-label': 'Enter item label (e.g. Marie Curie)...',
            'cradle-new-item-desc': 'Enter item description (e.g. Polish-French physicist)...',
            'cradle-new-item-aliases': 'Aliases (pipe-separated |, e.g. Marie Curie | Curie, Marie)...',
            'cradle-add-language': '+ Add another language',
            'cradle-add-value': 'Add Value',
            'cradle-save-changes': 'Save Changes',
            'cradle-create-item': 'Create Item',
            'cradle-cancel': 'Cancel',
            'cradle-select-predefined': '-- Select Predefined Form --',
            'cradle-method-predefined': 'Method 1: Use a Predefined Cradle Form',
            'cradle-method-schema': 'Method 2: Use an EntitySchema ID (ShEx)',
            'cradle-schema-placeholder': 'Enter EntitySchema ID (e.g. E10)',
            'cradle-load-schema': 'Load Schema',
            'cradle-validation-error': 'Please fix the following validation errors:\n\n',
            'cradle-mandatory-error': 'Property $1 ($2) is mandatory!',
            'cradle-label-required': 'New Item Label is required!',
            'cradle-no-changes': 'No changes detected!',
            'cradle-save-success': 'Claims successfully updated! Reloading...',
            'cradle-create-success': 'Item $1 successfully created! Redirecting...',
            'cradle-save-error': 'Error saving item: $1',
            'cradle-loading-schema': 'Loading schema $1...',
            'cradle-loading-templates': 'Loading templates from Wikidata:Cradle...',
            'cradle-enter-schema-title': 'Enter or select an EntitySchema to edit this item:',
            'cradle-change-schema': 'Change Schema',
            'cradle-edit-summary': 'Updated statements with [[User:Danielyepezgarces/Cradle-gadget|Cradle-gadget]] ([[EntitySchema:$1]])',
            'cradle-create-summary': 'New item created with [[User:Danielyepezgarces/Cradle-gadget|Cradle-gadget]] (Template: $1)',
            'cradle-search-placeholder': 'Search item...',
            'cradle-credits': 'Created by $1 & $2. Based on $3 by $4.',
            'cradle-hardselect-placeholder': 'hardselect QIDs (comma-separated, e.g. Q5,Q6)',
            'cradle-softselect-placeholder': 'softselect QIDs (comma-separated, e.g. Q5,Q6)',
            'cradle-schema-title-required': 'Schema title is required!',
            'cradle-schema-desc-placeholder': 'Schema description (e.g. Schema for football stadiums)...',
            'cradle-schema-aliases-placeholder': 'Schema aliases (pipe-separated |, e.g. stadium | arena)...',
            'cradle-schema-prop-required': 'You must add at least one property to the schema!',
            'cradle-prop-invalid-id': 'Invalid property ID (e.g. P17)!',
            'cradle-schema-not-found': 'Could not find the schema on the page!',
            'cradle-schema-saved': 'Schema saved successfully.',
            'cradle-schema-deleted': 'Schema deleted successfully.',
            'cradle-searching': ''+mw.msg('cradle-searching')+'',
            'cradle-hardselect-label': 'Fixed options (Hardselect)',
            'cradle-softselect-label': 'Free suggestions (Softselect)',
            'cradle-login-required-schema': 'Log in to create custom schemas.',
            'cradle-prop-search-placeholder': 'Search property by name or PID (e.g. P17, country)',
            'cradle-preset-none': 'No predefined values',
            'cradle-tab-predefined': 'Predefined Forms',
            'cradle-tab-shex': 'EntitySchema (ShEx)',
            'cradle-create-shex-designer': 'Design / Create new EntitySchema (ShEx)',
            'cradle-detected-schemas': 'Detected schemas for this item:',
            'cradle-or-enter-schema': 'Or enter another EntitySchema ID:',
            'cradle-search-value-placeholder': 'Search QID to add...',
            'cradle-btn-edit-with-cradle': 'Edit with Cradle',
            'cradle-validation-tab': 'Validation',
            'cradle-validation-title': 'Schema Validation Status',
            'cradle-validation-summary': 'Validation result for $1: $2 of $3 required, and $4 of $5 optional properties present.',
            'cradle-val-present': 'Present',
            'cradle-val-missing': 'Missing!',
            'cradle-val-optional-present': 'Optional (Present)',
            'cradle-val-optional-missing': 'Optional (Not set)',
            'cradle-val-err-min': 'Needs at least $1 value(s)',
            'cradle-val-err-max': 'Max $1 value(s) allowed',
            'cradle-val-err-qid': 'Invalid QID: $1',
            'cradle-val-err-num': 'Invalid number: $1',
            'cradle-custom-schemas': 'My Custom Schemas (stored in User Space)',
            'cradle-create-schema': 'Design New Schema',
            'cradle-search-community': 'Search Community Schemas',
            'cradle-save-schema': 'Save Schema',
            'cradle-delete-schema-confirm': 'Are you sure you want to delete the schema "$1"?',
            'cradle-schema-designer': 'Cradle Schema Designer',
            'cradle-add-property': 'Add Property',
            'cradle-save-changes': 'Save Changes',
            'cradle-back': 'Back',
            'cradle-schema-title': 'Schema Title',
            'cradle-schema-desc': 'Description',
            'cradle-btn-delete': 'Delete',
            'cradle-btn-edit': 'Edit',
            'cradle-btn-load': 'Load',
            'cradle-no-custom-schemas': 'You have no custom schemas yet.',
            'cradle-search-results': 'Search Results:',
            'cradle-no-results': 'No schemas found.',
            'cradle-search-btn': 'Search',
            'cradle-search-placeholder-community': 'Search user schemas...',
            'cradle-properties-list': 'Form Properties list:',
            'cradle-add-prop-btn': 'Add',
            'cradle-prop-placeholder': 'e.g. P17',
            'cradle-default-val-placeholder': 'default QID/string',
            'cradle-required-checkbox': 'Required',
            'cradle-export-shex': 'Export ShEx (EntitySchema)',
            'cradle-shex-preview': 'Generated ShEx (EntitySchema)',
            'cradle-copy-shex': 'Copy ShEx',
            'cradle-create-entityschema-btn': 'Publish EntitySchema on Wikidata',
            'cradle-user-menu-btn': 'Create new item with Cradle',
            'cradle-constraints-title': 'Wikidata constraints ($1)',
            'cradle-constraint-mandatory': 'Mandatory value constraint: A value for this property should be provided.',
            'cradle-constraint-single': 'Single value constraint: Only one value is allowed for this property.',
            'cradle-constraint-type': 'Type constraint: Ensure value matches the required entity type.',
            'cradle-constraint-format': 'Format constraint',
            'cradle-constraint-inverse': 'Inverse property constraint.',
            'cradle-constraint-distinct': 'Distinct values constraint.',
            'cradle-constraint-mandatory-alert': 'Property $1 ($2) has a Wikidata mandatory value constraint.',
            'cradle-shex-valid': '✓ Valid ShEx syntax for Wikidata',
            'cradle-shex-invalid': '⚠ Invalid ShEx syntax:',
            'cradle-publishing-shex': 'Publishing EntitySchema to Wikidata...',
            'cradle-publish-shex-success': 'EntitySchema $1 published successfully on Wikidata!'
        };

        // Load local English fallbacks first
        mw.messages.set(fallbackMessages);

        // Fetch translations dynamically from Wikidata User subpage
        let i18nUrl = mw.util.wikiScript('index') + '?title=User:Danielyepezgarces/Gadget-cradle/i18n.json&action=raw&ctype=application/json';
        
        $.getJSON(i18nUrl).then(function(data) {
            if (data) {
                // Load English translations first
                if (data['en']) mw.messages.set(data['en']);
                // Load current user language translations if available
                if (data[userLang]) mw.messages.set(data[userLang]);
            }
            proceedInit();
        }).catch(function(err) {
            console.warn("[Cradle] Could not load external translations, using local English fallback:", err);
            // Fallback for Spanish interface users
            if (userLang === 'es') {
                mw.messages.set({
                    'cradle-editor': 'Editor Cradle',
                    'cradle-edit-tab': 'Editar elemento actual',
                    'cradle-create-tab': 'Crear nuevo elemento',
                    'cradle-subtitle': 'Modificar declaraciones utilizando esquemas',
                    'cradle-change-form': 'Cambiar esquema',
                    'cradle-new-item-identity': 'Identidad del nuevo elemento',
                    'cradle-new-item-identity-desc': 'Proporciona la etiqueta, descripción y alias en uno o más idiomas.',
                    'cradle-new-item-label': 'Introduce la etiqueta del elemento (ej. Marie Curie)...',
                    'cradle-new-item-desc': 'Introduce la descripción del elemento (ej. física polaca-francesa)...',
                    'cradle-new-item-aliases': 'Alias (separados por plecas |, ej. Marie Curie | Curie, Marie)...',
                    'cradle-add-language': '+ Añadir otro idioma',
                    'cradle-add-value': 'Añadir valor',
                    'cradle-save-changes': 'Guardar cambios',
                    'cradle-create-item': 'Crear elemento',
                    'cradle-cancel': 'Cancelar',
                    'cradle-select-predefined': '-- Selecciona un formulario predefinido --',
                    'cradle-method-predefined': 'Usar un formulario predefinido de Cradle',
                    'cradle-method-schema': 'Usar un ID de EntitySchema (ShEx)',
                    'cradle-schema-placeholder': 'Introduce el ID del EntitySchema (ej. E10)',
                    'cradle-load-schema': 'Cargar esquema',
                    'cradle-validation-error': 'Por favor, corrige los siguientes errores de validación:\n\n',
                    'cradle-mandatory-error': '¡La propiedad $1 ($2) es obligatoria!',
                    'cradle-label-required': '¡La etiqueta del nuevo elemento es obligatoria!',
                    'cradle-no-changes': '¡No se detectaron cambios!',
                    'cradle-save-success': '¡Declaraciones actualizadas con éxito! Recargando...',
                    'cradle-create-success': '¡Elemento $1 creado con éxito! Redirigiendo...',
                    'cradle-save-error': 'Error al guardar el elemento: $1',
                    'cradle-loading-schema': 'Cargando el esquema $1...',
                    'cradle-loading-templates': 'Cargando plantillas desde Wikidata:Cradle...',
                    'cradle-enter-schema-title': 'Introduce o selecciona un EntitySchema para editar este elemento:',
                    'cradle-change-schema': 'Cambiar esquema',
                    'cradle-edit-summary': 'Declaraciones actualizadas con [[User:Danielyepezgarces/Cradle-gadget|Cradle-gadget]] ([[EntitySchema:$1]])',
                    'cradle-create-summary': 'Nuevo elemento creado con [[User:Danielyepezgarces/Cradle-gadget|Cradle-gadget]] (Plantilla: $1)',
                    'cradle-search-placeholder': 'Buscar elemento...',
                    'cradle-credits': 'Creado por $1 e $2. Basado en $3 por Magnus Manske.',
                    'cradle-btn-edit-with-cradle': 'Editar con Cradle',
                    'cradle-validation-tab': 'Validación',
                    'cradle-validation-title': 'Estado de validación de esquema',
                    'cradle-validation-summary': 'Resultado de la validación para $1: $2 de $3 obligatorias, y $4 de $5 opcionales presentes.',
                    'cradle-val-present': 'Presente',
                    'cradle-val-missing': '¡Falta!',
                    'cradle-val-optional-present': 'Opcional (Presente)',
                    'cradle-val-optional-missing': 'Opcional (Sin establecer)',
                    'cradle-val-err-min': 'Requiere al menos $1 valor(es)',
                    'cradle-val-err-max': 'Máximo $1 valor(es) permitidos',
                    'cradle-val-err-qid': 'QID no válido: $1',
                    'cradle-val-err-num': 'Número no válido: $1',
                    'cradle-export-shex': 'Exportar ShEx (EntitySchema)',
                    'cradle-shex-preview': 'Código ShEx generado (EntitySchema)',
                    'cradle-copy-shex': 'Copiar ShEx',
                    'cradle-create-entityschema-btn': 'Publicar EntitySchema en Wikidata',
                    'cradle-user-menu-btn': 'Crear elemento nuevo con Cradle',
                    'cradle-constraints-title': 'Restricciones de Wikidata ($1)',
                    'cradle-constraint-mandatory': 'Restricción de valor obligatorio: Se debe proporcionar un valor para esta propiedad.',
                    'cradle-constraint-single': 'Restricción de valor único: Solo se permite un único valor para esta propiedad.',
                    'cradle-constraint-type': 'Restricción de tipo de entidad: Verifique que el valor sea del tipo de entidad requerido.',
                    'cradle-constraint-format': 'Restricción de formato',
                    'cradle-constraint-inverse': 'Restricción de propiedad inversa.',
                    'cradle-constraint-distinct': 'Restricción de valores distintos.',
                    'cradle-constraint-mandatory-alert': 'La propiedad $1 ($2) tiene una restricción de valor obligatorio en Wikidata.',
                    'cradle-shex-valid': '✓ Sintaxis ShEx válida para Wikidata',
                    'cradle-shex-invalid': '⚠ Sintaxis ShEx no válida:',
                    'cradle-publishing-shex': 'Publicando EntitySchema en Wikidata...',
                    'cradle-publish-shex-success': '¡EntitySchema $1 publicado con éxito en Wikidata!',
                    'cradle-sidebar-header': 'Esquemas',
                    'cradle-sidebar-create-schema': 'Crear un esquema nuevo',
                    'cradle-sidebar-recent-schemas': 'Cambios recientes',
                    'cradle-sidebar-random-schema': 'Esquema aleatorio',
                    'cradle-tab-create-item': 'Crear elementos',
                    'cradle-tab-design-schema': 'Diseñar esquemas'
                });
            }
            proceedInit();
        });
    }

    /**
     * Completes script initialization.
     */
    function proceedInit() {
        mw.util.addCSS(customCSS);
        fetchSortedProperties();
        
        // Add Toolbox portlet link in the sidebar on all pages
        mw.util.addPortletLink(
            'p-tb',
            mw.util.getUrl('Special:Cradle'),
            'Cradle',
            't-cradle',
            'Create items using Cradle templates or schemas'
        );

        // Add dedicated 'Esquemas' section to Wikidata sidebar
        setupSidebarSchemasSection();

        if (isSpecialCradle) {
            setupSpecialPage();
        } else if (isItemPage) {
            createHeadingButton();
            
            // Scan for schemas if on an item page (uses caching/on-demand loader)
            schemasLoadedPromise = getEntityData().then(data => {
                return findAssociatedSchemas(data);
            }).then(schemas => {
                detectedSchemas = schemas;
                logDebug("[Cradle] Detected EntitySchemas:", detectedSchemas);
                return schemas;
            }).catch(err => {
                logError("[Cradle] Error loading claims/schemas:", err);
                return [];
            });
        }
    }

    /**
     * Adds a dedicated "Esquemas" section to the Wikidata sidebar matching Wikibase Lexeme portlet structure.
     */
    function setupSidebarSchemasSection() {
        if ($('#p-cradle-schemas').length) return;

        let sectionHeader = mw.msg('cradle-sidebar-header') || 'Esquemas';
        let createText = mw.msg('cradle-sidebar-create-schema') || 'Crear un esquema nuevo';
        let recentText = mw.msg('cradle-sidebar-recent-schemas') || 'Cambios recientes';
        let randomText = mw.msg('cradle-sidebar-random-schema') || 'Esquema aleatorio';

        let createUrl = mw.util.getUrl('Special:Cradle') + '#design';
        let recentUrl = mw.util.getUrl('Special:RecentChanges', { namespace: 640 });
        let randomUrl = mw.util.getUrl('Special:Random/EntitySchema');

        let $sidebar = $('#mw-panel, #p-navigation, .vector-main-menu-content, #mw-navigation').first();
        if (!$sidebar.length) return;

        let $portlet = $('<div>')
            .addClass('vector-menu mw-portlet mw-portlet-cradle-schemas portal')
            .attr('id', 'p-cradle-schemas');

        let $heading = $('<div>')
            .addClass('vector-menu-heading mw-portlet-heading')
            .text(sectionHeader);

        let $body = $('<div>').addClass('vector-menu-content mw-portlet-body');
        let $ul = $('<ul>').addClass('vector-menu-content-list body');

        let $liCreate = $('<li>').attr('id', 'n-cradle-newschema').addClass('mw-list-item')
            .append($('<a>').attr('href', createUrl).append($('<span>').text(createText)).on('click', function(e) {
                mw.storage.set('cradle-active-tab', 'design');
                if (isSpecialCradle || isItemPage) {
                    e.preventDefault();
                    window.location.hash = 'design';
                    openCradleDrawer();
                    renderCreateOptionsSelector();
                }
            }));

        let $liRecent = $('<li>').attr('id', 'n-cradle-recentchanges-schemas').addClass('mw-list-item')
            .append($('<a>').attr('href', recentUrl).append($('<span>').text(recentText)));

        let $liRandom = $('<li>').attr('id', 'n-cradle-randomschema').addClass('mw-list-item')
            .append($('<a>').attr('href', randomUrl).append($('<span>').text(randomText)));

        $ul.append($liCreate).append($liRecent).append($liRandom);
        $body.append($ul);
        $portlet.append($heading).append($body);

        if ($('#p-wikibase-lexeme-lexicographical-data').length) {
            $portlet.insertBefore('#p-wikibase-lexeme-lexicographical-data');
        } else if ($('#p-navigation').length) {
            $portlet.insertAfter('#p-navigation');
        } else if ($('#p-tb').length) {
            $portlet.insertBefore('#p-tb');
        } else {
            $sidebar.append($portlet);
        }
    }

    /**
     * Set up Special:Cradle full page view.
     */
    function setupSpecialPage() {
        activeMode = 'create';
        
        // Update browser document title
        document.title = "Cradle - Wikidata Form Editor";
        
        // Set main heading
        let $heading = $('#firstHeading');
        if ($heading.length) {
            $heading.text('Cradle - Wikidata Form Editor');
        }

        // Empty default content area
        let $contentArea = $('#mw-content-text');
        if ($contentArea.length === 0) return;
        $contentArea.empty();

        // Add structural HTML container
        let $container = $('<div>').addClass('cradle-fullpage-container');
        
        let $content = $('<div>').attr('id', 'cradle-content-area');
        let $footer = $('<div>').addClass('cradle-footer').attr('id', 'cradle-footer-area').css({
            'margin-top': '20px',
            'border-radius': '2px',
            'border': '1px solid var(--border-color-base, #a2a9b1)'
        });

        $container.append($content).append($footer);
        $contentArea.append($container);

        // Remove early hiding styles so the newly rendered content and heading are displayed cleanly
        let $earlyStyle = $('#cradle-early-hide-style');
        if ($earlyStyle.length) {
            $earlyStyle.remove();
        }

        renderCreateOptionsSelector();
    }

    /**
     * Creates the "Editar con Cradle" button inside the main heading.
     */
    function createHeadingButton() {
        let $heading = $('#firstHeading');
        if (!$heading.length) return;

        // Prevent adding duplicate buttons
        if ($('#cradle-heading-edit-btn').length) return;

        let $editBtn = $('<button>')
            .attr('id', 'cradle-heading-edit-btn')
            .addClass('cradle-edit-heading-btn')
            .text(mw.msg('cradle-btn-edit-with-cradle'))
            .on('click', openEditor);

        // Adjust margin-right dynamically if mw-indicators is present and populated
        let $indicators = $('.mw-indicators');
        if ($indicators.length && $indicators.children().length > 0) {
            let indicatorsWidth = $indicators.outerWidth() || 0;
            if (indicatorsWidth > 0) {
                $editBtn.css('margin-right', (indicatorsWidth + 16) + 'px');
            } else {
                // Fallback margin if width not yet computed
                $editBtn.css('margin-right', '48px');
            }
        }

        $heading.append($editBtn);
    }

    /**
     * Fetch the entity data from Wikidata Action API.
     */
    function loadEntityData(id) {
        return new Promise((resolve, reject) => {
            let api = new mw.Api();
            api.get({
                action: 'wbgetentities',
                ids: id,
                format: 'json'
            }).done(function(res) {
                if (res && res.entities && res.entities[id]) {
                    resolve(res.entities[id]);
                } else {
                    reject(new Error("Unable to load entity data"));
                }
            }).fail(function(err) {
                reject(err);
            });
        });
    }

    /**
     * Searches class properties (P12861) on P31, P279, and P106 claims of the entity.
     */
    function findAssociatedSchemas(data) {
        let schemas = [];
        
        // Direct schema on this item
        if (data.claims && data.claims[P12861]) {
            data.claims[P12861].forEach(claim => {
                let sId = parseEntitySchemaID(claim.mainsnak?.datavalue);
                if (sId && !schemas.includes(sId)) {
                    schemas.push(sId);
                }
            });
        }

        // Check instance of (P31), subclass of (P279), and occupation (P106)
        let classesToCheck = [];
        [P31, P279, P106].forEach(prop => {
            if (data.claims && data.claims[prop]) {
                data.claims[prop].forEach(claim => {
                    if (claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value) {
                        let classId = claim.mainsnak.datavalue.value.id;
                        if (classId && !classesToCheck.includes(classId)) {
                            classesToCheck.push(classId);
                        }
                    }
                });
            }
        });

        if (classesToCheck.length === 0) {
            return Promise.resolve(schemas);
        }

        return new Promise((resolve) => {
            let api = new mw.Api();
            api.get({
                action: 'wbgetentities',
                ids: classesToCheck.join('|'),
                props: 'claims',
                format: 'json'
            }).done(function(res) {
                if (res && res.entities) {
                    Object.keys(res.entities).forEach(qid => {
                        let cls = res.entities[qid];
                        if (cls.claims && cls.claims[P12861]) {
                            cls.claims[P12861].forEach(claim => {
                                let schemaId = parseEntitySchemaID(claim.mainsnak?.datavalue);
                                if (schemaId && !schemas.includes(schemaId)) {
                                    schemas.push(schemaId);
                                }
                            });
                        }
                    });
                }
                resolve(schemas);
            }).fail(function(err) {
                logError("[Cradle] findAssociatedSchemas request failed:", err);
                resolve(schemas);
            });
        });
    }

    /**
     * Opens the Sidebar Drawer editor.
     */
    function openEditor() {
        userWantsToChangeSchema = false;
        if ($('.cradle-drawer').length === 0) {
            createDrawerUI();
        }

        $('.cradle-drawer-overlay').addClass('open');
        $('.cradle-drawer').addClass('open');

        renderActiveView();
    }

    /**
     * Closes the Sidebar Drawer editor.
     */
    function closeEditor() {
        $('.cradle-drawer').removeClass('open');
        $('.cradle-drawer-overlay').removeClass('open');
        
        // Reset state so that next open reloads clean data
        schemaProperties = {};
        propertyMetadata = {};
        softselectLabels = {};
        formState = {};
        activeSchema = null;
        activeTemplate = null;
    }

    /**
     * Instantiates the Drawer HTML in the document body.
     */
    function createDrawerUI() {
        let $overlay = $('<div>').addClass('cradle-drawer-overlay');
        let $drawer = $('<div>').addClass('cradle-drawer');

        let $header = $('<div>').addClass('cradle-header');
        let $titleArea = $('<div>').addClass('cradle-title-area');
        $titleArea.append($('<h2>').addClass('cradle-title').text(mw.msg('cradle-editor')));
        
        // Render tabs
        let $tabs = $('<div>').addClass('cradle-tabs');
        if (isItemPage) {
            $tabs.append($('<div>').addClass('cradle-tab').attr('data-mode', 'edit').text(mw.msg('cradle-edit-tab')));
        }
        $tabs.append($('<div>').addClass('cradle-tab').attr('data-mode', 'create').text(mw.msg('cradle-create-tab')));
        $titleArea.append($tabs);
        
        let $closeBtn = $('<button>')
            .addClass('cradle-close-btn')
            .html(ICONS.close)
            .on('click', closeEditor);

        $header.append($titleArea).append($closeBtn);
        
        let $content = $('<div>').addClass('cradle-content').attr('id', 'cradle-content-area');
        let $footer = $('<div>').addClass('cradle-footer').attr('id', 'cradle-footer-area');

        $drawer.append($header).append($content).append($footer);
        
        $overlay.on('click', closeEditor);
        $drawer.on('click', function(e) { e.stopPropagation(); });

        $('body').append($overlay).append($drawer);

        // Bind tab events
        $drawer.find('.cradle-tab').on('click', function() {
            let mode = $(this).attr('data-mode');
            if (mode === 'create') {
                // Redirect directly to Special:Cradle instead of rendering inside drawer
                location.href = mw.util.getUrl('Special:Cradle');
                return;
            }
            activeMode = mode;
            $drawer.find('.cradle-tab').removeClass('active');
            $(this).addClass('active');
            renderActiveView();
        });
        
        // Set initial active tab
        $drawer.find(`.cradle-tab[data-mode="${activeMode}"]`).addClass('active');
    }

    /**
     * Renders either the Edit View or Create View based on activeMode.
     */
    function renderActiveView() {
        // If a schema or template is already active/loaded, just re-render the view
        if (Object.keys(schemaProperties).length > 0) {
            renderForm();
            return;
        }

        activeSchema = null;
        activeTemplate = null;
        
        if (activeMode === 'edit') {
            if (schemasLoadedPromise && !userWantsToChangeSchema) {
                // Show loader spinner while waiting for class schemas scan to complete
                let $content = $('#cradle-content-area').empty();
                $content.append($('<div>').css({'text-align': 'center', 'margin-top': '40px'})
                    .append($('<div>').addClass('cradle-spinner').css({'border-top-color': 'var(--border-color-progressive, #36c)', 'width': '30px', 'height': '30px'}))
                    .append($('<p>').text('Checking associated schemas...'))
                );

                schemasLoadedPromise.then(schemas => {
                    if (schemas.length > 0 && !userWantsToChangeSchema) {
                        loadAndDisplaySchema(schemas[0]);
                    } else {
                        renderEditSchemaSelector();
                    }
                });
            } else {
                renderEditSchemaSelector();
            }
        } else {
            renderCreateOptionsSelector();
        }
    }

    /**
     * Render schema selector for Edit mode.
     */
    function renderEditSchemaSelector() {
        let $content = $('#cradle-content-area').empty();
        updateDrawerFooter(false);

        let $box = $('<div>').addClass('cradle-selector-box');
        
        if (detectedSchemas.length > 0) {
            $box.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-detected-schemas')));
            let $btnGroup = $('<div>').css({'display': 'flex', 'flex-wrap': 'wrap', 'gap': '8px', 'margin-bottom': '16px'});
            detectedSchemas.forEach(schemaId => {
                let $btn = $('<button>')
                    .addClass('cradle-btn-secondary')
                    .css({'padding': '6px 12px'})
                    .text(schemaId)
                    .on('click', function() {
                        userWantsToChangeSchema = false;
                        loadAndDisplaySchema(schemaId);
                    });
                $btnGroup.append($btn);
            });
            $box.append($btnGroup);
            $box.append($('<p>').css({'font-weight': 'bold', 'margin-top': '12px'}).text(mw.msg('cradle-or-enter-schema')));
        } else {
            $box.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-enter-schema-title')));
        }

        let $manualInput = $('<input>')
            .addClass('cradle-input')
            .attr('type', 'text')
            .attr('placeholder', mw.msg('cradle-schema-placeholder'));

        let $loadBtn = $('<button>')
            .addClass('cradle-btn-secondary')
            .text(mw.msg('cradle-load-schema'))
            .on('click', function() {
                let schemaId = $manualInput.val().trim().toUpperCase();
                if (schemaId) {
                    if (!schemaId.startsWith('E')) {
                        schemaId = 'E' + schemaId.replace(/\D/g, '');
                    }
                    userWantsToChangeSchema = false;
                    loadAndDisplaySchema(schemaId);
                }
            });

        let $inputGroup = $('<div>').css({'display': 'flex', 'gap': '8px', 'margin-top': '8px'});
        $manualInput.css({'flex': '1'});
        $inputGroup.append($manualInput).append($loadBtn);
        $box.append($inputGroup);

        attachEntitySchemaAutocompleter($inputGroup, $manualInput, function(schemaId) {
            userWantsToChangeSchema = false;
            loadAndDisplaySchema(schemaId);
        });
        $content.append($box);
    }

    /**
     * Renders selection panel with 2 tabs: 'Crear elementos' and 'Diseñar esquemas'.
     */
    function renderCreateOptionsSelector() {
        let $content = $('#cradle-content-area').empty();
        updateDrawerFooter(false);

        // Render 2 Tabs Header
        let $tabsHeader = $('<div>').addClass('cradle-select-tabs');

        let tabs = [
            { id: 'create', label: mw.msg('cradle-tab-create-item') || 'Crear elementos' },
            { id: 'design', label: mw.msg('cradle-tab-design-schema') || 'Diseñar esquemas' }
        ];

        let hash = window.location.hash.toLowerCase();
        let search = window.location.search.toLowerCase();
        let activeTab = null;

        if (hash === '#design' || hash === '#designschema' || hash === '#design-schema' || search.includes('tab=design')) {
            activeTab = 'design';
        } else if (hash === '#create' || hash === '#createitem' || hash === '#create-item' || search.includes('tab=create')) {
            activeTab = 'create';
        } else {
            activeTab = mw.storage.get('cradle-active-tab');
        }

        if (activeTab !== 'create' && activeTab !== 'design') {
            activeTab = 'create';
        }

        tabs.forEach(tab => {
            let $tab = $('<button>')
                .addClass('cradle-select-tab')
                .text(tab.label)
                .on('click', function() {
                    mw.storage.set('cradle-active-tab', tab.id);
                    let newHash = tab.id === 'design' ? '#design' : '#create';
                    if (history.replaceState) {
                        history.replaceState(null, null, window.location.pathname + window.location.search + newHash);
                    } else {
                        window.location.hash = newHash;
                    }
                    renderCreateOptionsSelector();
                });
            if (activeTab === tab.id) {
                $tab.addClass('active');
            }
            $tabsHeader.append($tab);
        });
        $content.append($tabsHeader);

        if (activeTab === 'create') {
            // Tab 1: Load Existing EntitySchema (ShEx) to create an item
            let $loadBox = $('<div>').addClass('cradle-selector-box');
            $loadBox.append($('<h4>').css({'margin': '0 0 6px 0', 'font-size': '14px', 'color': '#202122'})
                .text(mw.msg('cradle-method-schema')));
            $loadBox.append($('<p>').css({'margin': '0 0 12px 0', 'font-size': '12px', 'color': '#54595d'})
                .text('Busca un EntitySchema existente (ej. E10, Humano) para cargar sus declaraciones y crear un nuevo elemento.'));

            let $schemaInput = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('placeholder', mw.msg('cradle-schema-placeholder'));

            let $schemaBtn = $('<button>')
                .addClass('cradle-btn-secondary')
                .text(mw.msg('cradle-load-schema'))
                .on('click', function() {
                    let schemaId = $schemaInput.val().trim().toUpperCase();
                    if (schemaId) {
                        if (!schemaId.startsWith('E')) {
                            schemaId = 'E' + schemaId.replace(/\D/g, '');
                        }
                        loadAndDisplaySchema(schemaId);
                    }
                });

            let $group = $('<div>').css({'display': 'flex', 'gap': '8px'});
            $schemaInput.css({'flex': '1'});
            $group.append($schemaInput).append($schemaBtn);
            $loadBox.append($group);

            attachEntitySchemaAutocompleter($group, $schemaInput, function(schemaId) {
                loadAndDisplaySchema(schemaId);
            });

            $content.append($loadBox);
        } else if (activeTab === 'design') {
            // Tab 2: Design New EntitySchema (ShEx)
            let $designBox = $('<div>').addClass('cradle-selector-box');
            $designBox.append($('<h4>').css({'margin': '0 0 6px 0', 'font-size': '14px', 'color': '#202122'})
                .text(mw.msg('cradle-schema-designer')));
            $designBox.append($('<p>').css({'margin': '0 0 14px 0', 'font-size': '12px', 'color': '#54595d'})
                .text('Diseña un nuevo esquema desde cero o importando propiedades de un elemento existente para publicarlo en Wikidata como un EntitySchema (ShEx).'));

            let $createDesignerBtn = $('<button>')
                .addClass('cdx-button cdx-button--action-progressive cdx-button--weight-primary')
                .css({
                    'width': '100%',
                    'display': 'inline-flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    'gap': '6px',
                    'min-height': '38px',
                    'font-weight': 'bold',
                    'font-size': '14px',
                    'box-sizing': 'border-box'
                })
                .html(ICONS.plus + ' <span>' + (mw.msg('cradle-create-shex-designer') || 'Diseñar / Crear nuevo EntitySchema (ShEx)') + '</span>')
                .on('click', function() {
                    renderSchemaDesigner();
                });
            $designBox.append($createDesignerBtn);

            $content.append($designBox);
        }
    }

    /**
     * Parse the wikitext on Wikidata:Cradle to build predefined form presets.
     */
    function parseCradleWikitext(wikitext) {
        let forms = {};
        let lines = wikitext.split('\n');
        let currentForm = null;
        
        lines.forEach(line => {
            line = line.trim();
            if (!line) return;
            
            // Match == Form Title ==
            let titleMatch = line.match(/^==\s*(.+?)\s*==$/);
            if (titleMatch) {
                let title = titleMatch[1];
                currentForm = {
                    title: title,
                    labels: {},
                    props: {}
                };
                forms[title.toLowerCase().replace(/ /g, '_')] = currentForm;
                return;
            }
            
            if (!currentForm) return;
            
            // Match language label translations: :de:Antike Töpfer...
            let langMatch = line.match(/^:([a-z-]+):(.+)$/);
            if (langMatch) {
                currentForm.labels[langMatch[1]] = langMatch[2].trim();
                return;
            }
            
            // Match property line: ;P31:hardselect:Q5|mandatory
            let propMatch = line.match(/^;\s*(P\d+)(?::(.*))?$/);
            if (propMatch) {
                let pid = propMatch[1];
                let rest = propMatch[2] || '';
                
                let propConfig = {
                    id: pid,
                    mandatory: false,
                    hardselect: [],
                    softselect: [],
                    defaultValue: ''
                };
                
                let parts = rest.split('|');
                parts.forEach(part => {
                    part = part.trim();
                    if (!part) return;
                    
                    if (part === 'mandatory') {
                        propConfig.mandatory = true;
                    } else {
                        let optMatch = part.match(/^([a-z]+):(.+)$/i);
                        if (optMatch) {
                            let key = optMatch[1].toLowerCase();
                            let val = optMatch[2];
                            if (key === 'hardselect') {
                                propConfig.hardselect = val.split(',').map(s => s.trim());
                            } else if (key === 'softselect') {
                                propConfig.softselect = val.split(',').map(s => s.trim());
                            } else if (key === 'default') {
                                propConfig.defaultValue = val.trim();
                            }
                        }
                    }
                });
                
                currentForm.props[pid] = propConfig;
            }
        });
        
        return forms;
    }

    /**
     * Loads wikitext of Wikidata:Cradle.
     */
    function loadCradleWikitext() {
        let api = new mw.Api();
        return api.get({
            action: 'query',
            prop: 'revisions',
            titles: 'Wikidata:Cradle',
            rvslots: 'main',
            rvprop: 'content',
            format: 'json'
        }).then(res => {
            let pages = res.query.pages;
            let pageId = Object.keys(pages)[0];
            if (pageId === "-1") {
                throw new Error("Wikidata:Cradle page not found");
            }
            return pages[pageId].revisions[0].slots.main['*'];
        });
    }

    /**
     * Loads a predefined form preset from Wikidata:Cradle and displays it.
     */
    function loadAndDisplayTemplate(key) {
        let $content = $('#cradle-content-area').empty();
        $content.append($('<div>').css({'text-align': 'center', 'margin-top': '40px'})
            .append($('<div>').addClass('cradle-spinner').css({'border-top-color': 'var(--border-color-progressive, #36c)'}))
            .append($('<p>').text(`Loading form template...`))
        );
        updateDrawerFooter(false);

        let t = cradleTemplates[key];
        activeTemplate = t;
        
        let propIds = Object.keys(t.props);
        let softselectQids = [];
        propIds.forEach(pid => {
            let pDef = t.props[pid];
            softselectQids = softselectQids.concat(pDef.hardselect).concat(pDef.softselect);
            if (pDef.defaultValue && pDef.defaultValue.startsWith('Q')) {
                softselectQids.push(pDef.defaultValue);
            }
        });

        getEntityData().then(() => {
            return Promise.all([
                loadPropertiesMetadata(propIds),
                loadItemLabels(softselectQids)
            ]);
        }).then(results => {
            propertyMetadata = results[0];
            softselectLabels = results[1];
            
            // Map cradle format to parser properties
            schemaProperties = {};
            propIds.forEach(pid => {
                let pDef = t.props[pid];
                schemaProperties[pid] = {
                    id: pid,
                    min: pDef.mandatory ? 1 : 0,
                    max: Infinity,
                    mandatory: pDef.mandatory,
                    softselect: pDef.hardselect.length > 0 ? pDef.hardselect : pDef.softselect,
                    defaultValue: pDef.defaultValue
                };
            });

            initializeFormState();
            renderForm();
        }).catch(err => {
            console.error(err);
            $content.empty().append($('<div>').addClass('cradle-selector-box').css('border-color', 'var(--color-destructive, #d33)')
                .append($('<p>').css({'color': 'var(--color-destructive, #d33)', 'font-weight': 'bold'}).text('Error loading template'))
                .append($('<button>').addClass('cradle-btn-secondary').text('Back').on('click', renderActiveView))
            );
        });
    }

    /**
     * Retrieves or fetches entity data on-demand, resolving race conditions.
     */
    function getEntityData() {
        if (!isItemPage) return Promise.resolve(null);
        if (entityData) return Promise.resolve(entityData);
        if (entityDataPromise) return entityDataPromise;
        
        entityDataPromise = loadEntityData(entityId).then(data => {
            entityData = data;
            return entityData;
        });
        return entityDataPromise;
    }

    /**
     * Loads the EntitySchema page content, parses it, fetches metadata and renders the form.
     */
    function loadAndDisplaySchema(schemaId) {
        activeSchema = { id: schemaId, label: schemaId };
        
        let $content = $('#cradle-content-area').empty();
        updateDrawerFooter(false);
        $content.append($('<div>').css({'text-align': 'center', 'margin-top': '40px'})
            .append($('<div>').addClass('cradle-spinner').css({'border-top-color': 'var(--border-color-progressive, #36c)', 'width': '30px', 'height': '30px'}))
            .append($('<p>').text(mw.msg('cradle-loading-schema', schemaId)))
        );

        getEntityData().then(() => {
            return fetchSchema(schemaId);
        }).then(schema => {
            activeSchema = schema;
            if (true) {
                $('.cradle-subtitle').text(`Schema: ${schema.label} (${schema.id})`);
            }
            
            // Parse properties in the ShEx schema
            schemaProperties = parseShEx(schema.schemaText);
            let propIds = Object.keys(schemaProperties);
            
            if (propIds.length === 0) {
                throw new Error("No properties found in this schema");
            }

            // Extract all softselect QIDs from all parsed properties
            let softselectQids = [];
            propIds.forEach(pid => {
                if (schemaProperties[pid].softselect) {
                    softselectQids = softselectQids.concat(schemaProperties[pid].softselect);
                }
            });

            // Fetch property metadata and softselect Q-item labels in parallel
            return Promise.all([
                loadPropertiesMetadata(propIds),
                loadItemLabels(softselectQids)
            ]);
        }).then(results => {
            propertyMetadata = results[0];
            softselectLabels = results[1];
            
            initializeFormState();
            renderForm();
        }).catch(err => {
            console.error(err);
            $content.empty().append($('<div>').addClass('cradle-selector-box').css('border-color', 'var(--color-destructive, #d33)')
                .append($('<p>').css({'color': 'var(--color-destructive, #d33)', 'font-weight': 'bold'}).text('Error loading schema'))
                .append($('<p>').text(err.message || 'Unknown error occurred'))
                .append($('<button>').addClass('cradle-btn-secondary').text('Back').on('click', renderActiveView))
            );
        });
    }

    /**
     * Fetch EntitySchema from the MediaWiki API.
     */
    function fetchSchema(schemaId) {
        let api = new mw.Api();
        return api.get({
            action: 'query',
            prop: 'revisions',
            titles: 'EntitySchema:' + schemaId,
            rvslots: 'main',
            rvprop: 'content',
            format: 'json'
        }).then(res => {
            let pages = res.query.pages;
            let pageId = Object.keys(pages)[0];
            if (pageId === "-1") {
                throw new Error(`Schema ${schemaId} does not exist`);
            }
            let rawContent = pages[pageId].revisions[0].slots.main['*'];
            try {
                let parsed = JSON.parse(rawContent);
                return {
                    id: schemaId,
                    label: (parsed.labels && (parsed.labels[mw.config.get('wgUserLanguage')] || parsed.labels['en'])) || schemaId,
                    schemaText: parsed.schemaText
                };
            } catch (e) {
                return {
                    id: schemaId,
                    label: schemaId,
                    schemaText: rawContent
                };
            }
        });
    }

    /**
     * A lightweight ShEx schema parser.
     */
    function parseShEx(shexText) {
        // Remove comments
        shexText = shexText.replace(/(?<!\<)#.*(\n|$)/mg, "\n");
        
        // Find start shape
        let startMatch = shexText.match(/start\s*=\s*@<\s*(.+?)\s*>/i);
        let startShape = startMatch ? startMatch[1] : null;
        
        // Find shape contents and EXTRA properties
        let shapes = {};
        let shapeExtraPids = [];
        let shapeRegex = /<([^>]+)>\s*(?:EXTRA\s+([^{]+))?\s*\{([\s\S]*?)\}/gi;
        let match;
        while ((match = shapeRegex.exec(shexText)) !== null) {
            let shapeName = match[1];
            let extraStr = match[2] || '';
            let shapeContent = match[3];
            shapes[shapeName] = shapeContent;
            
            if (!startShape || startShape === shapeName) {
                startShape = shapeName;
                if (extraStr) {
                    let pids = extraStr.match(/P\d+/gi) || [];
                    shapeExtraPids = pids.map(p => p.toUpperCase());
                    if (shapeExtraPids.length === 0) {
                        shapeExtraPids.push('ALL');
                    }
                }
            }
        }
        
        let targetText = shexText;
        if (startShape && shapes[startShape]) {
            targetText = shapes[startShape];
        }

        let props = {};
        let parts = targetText.split(';');
        parts.forEach(part => {
            part = part.trim();
            if (!part) return;
            
            // Match wdt:P123 or ps:P123
            let m = part.match(/(?:wdt|p|ps|pxt):(P\d+)\s*(.*)/);
            if (!m) return;
            
            let propId = m[1];
            let rest = m[2].trim();
            
            let min = 0;
            let max = Infinity;
            let mandatory = false;
            
            // Cardinality checks
            if (rest.endsWith('+')) {
                min = 1;
                mandatory = true;
            } else if (rest.endsWith('*')) {
                min = 0;
            } else if (rest.endsWith('?')) {
                min = 0;
                max = 1;
            } else {
                let cardMatch = rest.match(/\{\s*(\d+)\s*\}/);
                if (cardMatch) {
                    min = parseInt(cardMatch[1]);
                    max = min;
                } else {
                    let rangeMatch = rest.match(/\{\s*(\d+)\s*,\s*(\d+)?\s*\}/);
                    if (rangeMatch) {
                        min = parseInt(rangeMatch[1]);
                        max = rangeMatch[2] ? parseInt(rangeMatch[2]) : Infinity;
                    } else {
                        min = 1;
                        max = 1;
                        mandatory = true;
                    }
                }
            }
            if (min > 0) mandatory = true;
            
            // Extract softselect [wd:Q1 wd:Q2]
            let softselect = [];
            let allowedMatch = rest.match(/\[\s*([^\]]+)\s*\]/);
            if (allowedMatch) {
                let itemsText = allowedMatch[1];
                let qids = itemsText.match(/Q\d+/g) || [];
                softselect = qids;
            }
            
            if (shapeExtraPids.includes(propId) || shapeExtraPids.includes('ALL')) {
                max = Infinity;
            }

            props[propId] = {
                id: propId,
                min: min,
                max: max,
                mandatory: mandatory,
                softselect: softselect
            };
        });
        
        return props;
    }

    /**
     * Parses property constraints from Wikidata claims (P2302).
     */
    function parsePropertyConstraints(claims) {
        let constraints = [];
        if (!claims || !claims.P2302) return constraints;

        claims.P2302.forEach(claim => {
            if (claim.mainsnak && claim.mainsnak.snaktype === 'value' && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value) {
                let constraintQid = claim.mainsnak.datavalue.value.id;
                let cInfo = { qid: constraintQid, text: '' };

                if (constraintQid === 'Q21503250') {
                    cInfo.text = mw.msg('cradle-constraint-mandatory');
                    cInfo.isMandatory = true;
                } else if (constraintQid === 'Q21510865') {
                    cInfo.text = mw.msg('cradle-constraint-single');
                    cInfo.isSingle = true;
                    if (claim.qualifiers && (claim.qualifiers.P2309 || claim.qualifiers.P2303 || claim.qualifiers.P2308)) {
                        cInfo.hasScopeQualifier = true;
                    }
                } else if (constraintQid === 'Q21503252') {
                    cInfo.text = mw.msg('cradle-constraint-type');
                    cInfo.isType = true;
                } else if (constraintQid === 'Q21502404') {
                    let regexVal = '';
                    if (claim.qualifiers && claim.qualifiers.P1793 && claim.qualifiers.P1793[0] && claim.qualifiers.P1793[0].datavalue) {
                        regexVal = claim.qualifiers.P1793[0].datavalue.value;
                    }
                    cInfo.text = mw.msg('cradle-constraint-format') + (regexVal ? ` (${regexVal})` : '');
                    cInfo.regex = regexVal;
                } else if (constraintQid === 'Q21510851') {
                    cInfo.text = mw.msg('cradle-constraint-inverse');
                    cInfo.isInverse = true;
                } else if (constraintQid === 'Q21510862') {
                    cInfo.text = mw.msg('cradle-constraint-distinct');
                    cInfo.isDistinct = true;
                } else if (constraintQid === 'Q54554025') {
                    cInfo.text = mw.msg('cradle-constraint-citation') || 'Statements should have at least one reference.';
                    cInfo.isCitationNeeded = true;
                } else if (constraintQid === 'Q21510855') {
                    let allowedValues = [];
                    if (claim.qualifiers && claim.qualifiers.P2305) {
                        claim.qualifiers.P2305.forEach(q => {
                            if (q.datavalue && q.datavalue.value && q.datavalue.value.id) {
                                allowedValues.push(q.datavalue.value.id);
                            }
                        });
                    }
                    cInfo.text = 'One-of constraint';
                    cInfo.allowedValues = allowedValues;
                }

                if (cInfo.text) {
                    constraints.push(cInfo);
                }
            }
        });
        return constraints;
    }

    /**
     * Fetches property metadata.
     */
    function loadPropertiesMetadata(propIds) {
        logDebug("[Cradle] Loading properties metadata for:", propIds);
        return new Promise((resolve) => {
            let api = new mw.Api();
            let userLang = mw.config.get('wgUserLanguage') || 'en';
            api.get({
                action: 'wbgetentities',
                ids: propIds.join('|'),
                props: 'info|labels|descriptions|datatype|claims',
                languages: userLang + '|en',
                format: 'json'
            }).done(function(res) {
                let metadata = {};
                if (res && res.entities) {
                    Object.keys(res.entities).forEach(pid => {
                        let ent = res.entities[pid];
                        let label = pid;
                        if (ent.labels) {
                            label = (ent.labels[userLang] && ent.labels[userLang].value) ||
                                    (ent.labels['en'] && ent.labels['en'].value) ||
                                    pid;
                        }
                        
                        let desc = "";
                        let p2559Texts = [];
                        if (ent.claims && ent.claims.P2559) {
                            ent.claims.P2559.forEach(claim => {
                                if (claim.mainsnak && 
                                    claim.mainsnak.snaktype === 'value' && 
                                    claim.mainsnak.datavalue && 
                                    claim.mainsnak.datavalue.value) {
                                    let val = claim.mainsnak.datavalue.value;
                                    if (val.text && val.language) {
                                        p2559Texts.push({
                                            text: val.text,
                                            language: val.language
                                        });
                                    }
                                }
                            });
                        }

                        // 1. Try P2559 in user interface language
                        let targetUsage = p2559Texts.find(t => t.language === userLang);
                        if (targetUsage) {
                            desc = targetUsage.text;
                        } else {
                            // 2. Try P2559 in English
                            let enUsage = p2559Texts.find(t => t.language === 'en');
                            if (enUsage) {
                                desc = enUsage.text;
                            } else {
                                // 3. Try standard description in user interface language
                                if (ent.descriptions && ent.descriptions[userLang]) {
                                    desc = ent.descriptions[userLang].value;
                                } else if (ent.descriptions && ent.descriptions['en']) {
                                    // 4. Try standard description in English
                                    desc = ent.descriptions['en'].value;
                                }
                            }
                        }

                        metadata[pid] = {
                            id: pid,
                            label: label,
                            description: desc,
                            datatype: ent.datatype,
                            constraints: parsePropertyConstraints(ent.claims)
                        };
                    });
                }
                logDebug("[Cradle] Loaded properties metadata:", metadata);
                resolve(metadata);
            }).fail(function(err) {
                logError("[Cradle] loadPropertiesMetadata request failed:", err);
                resolve({});
            });
        });
    }

    /**
     * Fetch labels for specific QIDs.
     */
    function loadItemLabels(qids) {
        if (qids.length === 0) return Promise.resolve({});
        qids = [...new Set(qids)];
        logDebug("[Cradle] Loading item labels for:", qids);
        return new Promise((resolve) => {
            let api = new mw.Api();
            let userLang = mw.config.get('wgUserLanguage') || 'en';
            api.get({
                action: 'wbgetentities',
                ids: qids.join('|'),
                props: 'labels',
                languages: userLang + '|en',
                format: 'json'
            }).done(function(res) {
                let labels = {};
                if (res && res.entities) {
                    Object.keys(res.entities).forEach(qid => {
                        let ent = res.entities[qid];
                        let label = qid;
                        if (ent.labels) {
                            label = (ent.labels[userLang] && ent.labels[userLang].value) ||
                                    (ent.labels['en'] && ent.labels['en'].value) ||
                                    qid;
                        }
                        labels[qid] = label;
                    });
                }
                logDebug("[Cradle] Loaded labels map:", labels);
                resolve(labels);
            }).fail(function(err) {
                logError("[Cradle] loadItemLabels request failed:", err);
                resolve({});
            });
        });
    }

    /**
     * Fetch labels AND descriptions for specific QIDs.
     */
    function loadItemDetails(qids) {
        if (qids.length === 0) return Promise.resolve({});
        qids = [...new Set(qids)];
        return new Promise((resolve) => {
            let api = new mw.Api();
            let userLang = mw.config.get('wgUserLanguage') || 'en';
            api.get({
                action: 'wbgetentities',
                ids: qids.join('|'),
                props: 'labels|descriptions',
                languages: userLang + '|en',
                format: 'json'
            }).done(function(res) {
                let details = {};
                if (res && res.entities) {
                    Object.keys(res.entities).forEach(qid => {
                        let ent = res.entities[qid];
                        let label = qid;
                        let desc = '';
                        if (ent.labels) {
                            label = (ent.labels[userLang] && ent.labels[userLang].value) ||
                                    (ent.labels['en'] && ent.labels['en'].value) ||
                                    qid;
                        }
                        if (ent.descriptions) {
                            desc = (ent.descriptions[userLang] && ent.descriptions[userLang].value) ||
                                   (ent.descriptions['en'] && ent.descriptions['en'].value) ||
                                   '';
                        }
                        details[qid] = { label: label, description: desc };
                    });
                }
                resolve(details);
            }).fail(function() {
                resolve({});
            });
        });
    }

    /**
     * Populates formState by mapping current entity claims to the parsed schema properties.
     */
    function initializeFormState() {
        formState = {};
        
        Object.keys(schemaProperties).forEach(pid => {
            let propDef = schemaProperties[pid];
            let meta = propertyMetadata[pid] || { datatype: 'string' };
            formState[pid] = [];
            
            // Map existing claims on the entity (if on an item page)
            if (isItemPage && entityData && entityData.claims && entityData.claims[pid]) {
                entityData.claims[pid].forEach(claim => {
                    if (claim.mainsnak && claim.mainsnak.snaktype === 'value' && claim.mainsnak.datavalue) {
                        let value = parseClaimValue(claim.mainsnak.datavalue);
                        formState[pid].push({
                            id: Math.random().toString(36).substring(2, 9),
                            guid: claim.id,
                            value: value,
                            datatype: meta.datatype,
                            rank: claim.rank || 'normal',
                            references: claim.references || [],
                            qualifiers: claim.qualifiers || {},
                            isDeleted: false
                        });
                    }
                });
            }
            
            // Set defaults or blank rows in create mode
            if (formState[pid].length === 0) {
                let initVal = '';
                if (activeMode === 'create' && propDef.defaultValue) {
                    initVal = propDef.defaultValue;
                }
                
                if (propDef.mandatory || initVal !== '') {
                    let newRow = createNewRowState(meta.datatype);
                    if (initVal !== '') newRow.value = initVal;
                    formState[pid].push(newRow);
                }
            } else if (formState[pid].length > 1) {
                // If item already has multiple claims, allow adding/removing values
                propDef.max = Infinity;
            }
        });
    }

    const MONTH_NAMES_ES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const MONTH_NAMES_EN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    function getMonthName(monthNum, lang, style) {
        if (monthNum < 1 || monthNum > 12) return String(monthNum);
        let monthStyle = style || 'short';
        try {
            let d = new Date(2000, monthNum - 1, 15);
            let userLang = lang || mw.config.get('wgUserLanguage') || 'es';
            let monthName = new Intl.DateTimeFormat(userLang, { month: monthStyle }).format(d);
            return monthName;
        } catch(e) {
            let isEs = (lang || '').startsWith('es');
            return isEs ? MONTH_NAMES_ES[monthNum] : MONTH_NAMES_EN[monthNum];
        }
    }

    function formatWikibaseDate(isoTime, precision) {
        if (!isoTime) return '';
        let isNegative = isoTime.startsWith('-');
        let clean = isoTime.replace(/^[+-]/, '').replace(/T.*$/, '');
        let parts = clean.split('-');
        let yearNum = parseInt(parts[0], 10) || 0;
        let monthNum = parseInt(parts[1], 10) || 0;
        let dayNum = parseInt(parts[2], 10) || 0;

        let userLang = mw.config.get('wgUserLanguage') || 'es';
        let isEs = userLang.startsWith('es');
        let signStr = isNegative ? ' BCE' : '';

        if (precision <= 9 || monthNum === 0) {
            return (isNegative ? '-' : '') + yearNum + signStr;
        }

        let monthName = getMonthName(monthNum, userLang, 'short');
        let monthNameLong = getMonthName(monthNum, userLang, 'long');

        if (precision === 10 || dayNum === 0) {
            return isEs ? `${monthNameLong} de ${yearNum}${signStr}` : `${monthNameLong} ${yearNum}${signStr}`;
        }

        return isEs ? `${dayNum} de ${monthName} de ${yearNum}${signStr}` : `${dayNum} ${monthName} ${yearNum}${signStr}`;
    }

    function parseNaturalDate(inputStr) {
        let str = String(inputStr || '').trim();
        if (!str) return null;

        let isNegative = false;
        if (str.startsWith('-')) {
            isNegative = true;
            str = str.substring(1);
        } else if (str.startsWith('+')) {
            str = str.substring(1);
        }

        str = str.replace(/T.*$/, '').replace(/,/g, ' ').replace(/\bde\b/gi, ' ').replace(/\bof\b/gi, ' ').trim();
        str = str.replace(/\s+/g, ' ');

        let monthMap = {
            'january': 1, 'jan': 1, 'february': 2, 'feb': 2, 'march': 3, 'mar': 3,
            'april': 4, 'apr': 4, 'may': 5, 'june': 6, 'jun': 6, 'july': 7, 'jul': 7,
            'august': 8, 'aug': 8, 'september': 9, 'sep': 9, 'sept': 9,
            'october': 10, 'oct': 10, 'november': 11, 'nov': 11, 'december': 12, 'dec': 12,
            'enero': 1, 'ene': 1, 'febrero': 2, 'feb': 2, 'marzo': 3, 'abril': 4, 'abr': 4,
            'mayo': 5, 'junio': 6, 'jun': 6, 'julio': 7, 'jul': 7, 'agosto': 8, 'ago': 8,
            'septiembre': 9, 'setiembre': 9, 'octubre': 10, 'oct': 10, 'noviembre': 11, 'nov': 11, 'diciembre': 12, 'dic': 12
        };

        let userLang = mw.config.get('wgUserLanguage') || 'es';
        for (let m = 1; m <= 12; m++) {
            try {
                let d = new Date(2000, m - 1, 15);
                let longName = new Intl.DateTimeFormat(userLang, { month: 'long' }).format(d).toLowerCase();
                let shortName = new Intl.DateTimeFormat(userLang, { month: 'short' }).format(d).toLowerCase().replace(/\./g, '');
                monthMap[longName] = m;
                monthMap[shortName] = m;
            } catch(e) {}
        }

        let tokens = str.split(/[\s/\.\-]+/);
        let day = 0;
        let month = 0;
        let year = 0;
        let precision = 9;

        let numTokens = [];
        tokens.forEach(t => {
            let lower = t.toLowerCase();
            if (monthMap[lower]) {
                month = monthMap[lower];
            } else if (/^\d+$/.test(t)) {
                numTokens.push(parseInt(t, 10));
            }
        });

        if (month > 0) {
            if (numTokens.length === 1) {
                year = numTokens[0];
                precision = 10;
            } else if (numTokens.length >= 2) {
                if (numTokens[0] > 31) {
                    year = numTokens[0];
                    day = numTokens[1];
                } else if (numTokens[1] > 31) {
                    day = numTokens[0];
                    year = numTokens[1];
                } else {
                    day = numTokens[0];
                    year = numTokens[1];
                }
                precision = 11;
            }
        } else {
            if (numTokens.length === 1) {
                year = numTokens[0];
                precision = 9;
            } else if (numTokens.length === 2) {
                if (numTokens[0] > 31) {
                    year = numTokens[0];
                    month = numTokens[1];
                } else {
                    month = numTokens[0];
                    year = numTokens[1];
                }
                precision = 10;
            } else if (numTokens.length >= 3) {
                if (numTokens[0] > 31) {
                    year = numTokens[0];
                    month = numTokens[1];
                    day = numTokens[2];
                } else if (numTokens[2] > 31) {
                    day = numTokens[0];
                    month = numTokens[1];
                    year = numTokens[2];
                } else {
                    day = numTokens[0];
                    month = numTokens[1];
                    year = numTokens[2];
                }
                precision = 11;
            }
        }

        if (year <= 0) return null;

        let yearStr = String(year).padStart(4, '0');
        let monthStr = (month > 0) ? String(month).padStart(2, '0') : '00';
        let dayStr = (day > 0) ? String(day).padStart(2, '0') : '00';

        let isoTime = (isNegative ? '-' : '+') + yearStr + '-' + monthStr + '-' + dayStr + 'T00:00:00Z';

        return {
            type: 'time',
            value: {
                time: isoTime,
                timezone: 0,
                before: 0,
                after: 0,
                precision: precision,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727'
            }
        };
    }

    /**
     * Extracts values from Wikibase datavalue object based on type.
     */
    function parseClaimValue(datavalue) {
        let t = datavalue.type;
        let val = datavalue.value;
        if (t === 'wikibase-entityid') {
            return val.id;
        } else if (t === 'string') {
            return val;
        } else if (t === 'monolingualtext') {
            return { text: val.text, language: val.language };
        } else if (t === 'quantity') {
            let amt = val.amount;
            if (amt.startsWith('+')) amt = amt.substring(1);
            return amt;
        } else if (t === 'time') {
            return formatWikibaseDate(val.time, val.precision);
        }
        return JSON.stringify(val);
    }

    /**
     * Creates standard structure for a new input row.
     */
    function createNewRowState(datatype) {
        let defaultValue = '';
        if (datatype === 'monolingualtext') {
            defaultValue = { text: '', language: mw.config.get('wgUserLanguage') || 'en' };
        }
        return {
            id: Math.random().toString(36).substring(2, 9),
            guid: null,
            value: defaultValue,
            datatype: datatype,
            rank: 'normal',
            references: [],
            qualifiers: {},
            isDeleted: false
        };
    }

    /**
     * Renders the schema validation results view.
     */
    /**
     * Runs schema validation on the current formState.
     */
    function validateFormState() {
        let results = {
            properties: {},
            totalRequired: 0,
            presentRequired: 0,
            totalOptional: 0,
            presentOptional: 0
        };

        Object.keys(schemaProperties).forEach(pid => {
            let propDef = schemaProperties[pid];
            let meta = propertyMetadata[pid] || { datatype: 'string' };
            let datatype = meta.datatype || 'string';
            
            let min = propDef.min !== undefined ? propDef.min : 0;
            let max = propDef.max !== undefined ? propDef.max : '*';
            
            // Get active claims
            let claims = formState[pid] || [];
            let activeClaims = claims.filter(c => !c.isDeleted && c.value !== '' && (typeof c.value !== 'object' || c.value.text !== ''));
            let isPresent = (activeClaims.length > 0);

            // Validation checks
            let errors = [];
            
            // 1. Cardinality checks
            if (activeClaims.length < min) {
                errors.push(mw.msg('cradle-val-err-min', min));
            }
            if (max !== '*' && max !== Infinity && activeClaims.length > max) {
                errors.push(mw.msg('cradle-val-err-max', max));
            }
            
            // 2. Format checks
            activeClaims.forEach(claim => {
                let val = claim.value;
                if (datatype === 'wikibase-item') {
                    if (typeof val === 'string' && !/^[qQ]\d+$/.test(val.trim())) {
                        errors.push(mw.msg('cradle-val-err-qid', val));
                    }
                } else if (datatype === 'quantity') {
                    if (typeof val === 'string' && isNaN(Number(val.trim()))) {
                        errors.push(mw.msg('cradle-val-err-num', val));
                    }
                }
            });

            let isValid = (errors.length === 0);
            let isRequired = (min >= 1);

            if (isRequired) {
                results.totalRequired++;
                if (isValid && isPresent) {
                    results.presentRequired++;
                }
            } else {
                results.totalOptional++;
                if (isValid && isPresent) {
                    results.presentOptional++;
                }
            }

            let itemClass = "";
            let badgeText = "";
            let statusText = "";
            
            let badgeHtml = "";
            if (isRequired) {
                if (isPresent && isValid) {
                    itemClass = "valid";
                    badgeHtml = ICONS.check;
                    statusText = mw.msg('cradle-val-present');
                } else {
                    itemClass = "invalid";
                    badgeHtml = ICONS.close;
                    statusText = errors.length > 0 ? errors.join(', ') : mw.msg('cradle-val-missing');
                }
            } else {
                if (isPresent) {
                    if (isValid) {
                        itemClass = "optional-present";
                        badgeHtml = ICONS.info;
                        statusText = mw.msg('cradle-val-optional-present');
                    } else {
                        itemClass = "invalid";
                        badgeHtml = ICONS.close;
                        statusText = errors.join(', ');
                    }
                } else {
                    itemClass = "optional-missing";
                    badgeHtml = ICONS.alert;
                    statusText = mw.msg('cradle-val-optional-missing');
                }
            }

            results.properties[pid] = {
                isValid: isValid,
                isPresent: isPresent,
                isRequired: isRequired,
                errors: errors,
                itemClass: itemClass,
                badgeHtml: badgeHtml,
                statusText: statusText
            };
        });

        return results;
    }

    /**
     * Evaluates statement-level Wikibase Quality Constraints (wbqc) taking into account claim ranks (preferred/deprecated).
     */
    function evaluateRowConstraints(pid, row, allRows) {
        if (row.isDeleted || row.rank === 'deprecated') return { violations: [], suggestions: [] };
        let meta = propertyMetadata[pid];
        if (!meta) return { violations: [], suggestions: [] };

        let violations = [];
        let suggestions = [];
        let isEmpty = isEmptyValue(row.value, row.datatype);

        let activeRows = allRows.filter(r => !r.isDeleted && r.rank !== 'deprecated');
        let preferredRows = activeRows.filter(r => r.rank === 'preferred');

        // 1. References / citation-needed -> Suggestion (Only if P2302 has Q54554025 citation-needed constraint)
        let EXEMPT_CITATION_DATATYPES = ['commonsMedia', 'url', 'external-id', 'geo-shape', 'tabular-data', 'math', 'musical-notation'];
        let hasCitationConstraint = meta.constraints && meta.constraints.some(c => c.isCitationNeeded || c.qid === 'Q54554025');

        if (hasCitationConstraint && !isEmpty && (!row.references || row.references.length === 0) && !EXEMPT_CITATION_DATATYPES.includes(row.datatype)) {
            suggestions.push({
                type: 'suggestion',
                name: 'citation-needed constraint',
                message: `Statements for <a title="Property:${pid}" href="/wiki/Property:${pid}">${meta.label}</a> should have at least one reference.`,
                helpUrl: 'https://www.wikidata.org/wiki/Special:MyLanguage/Help:Property_constraints_portal/Q54554025',
                talkUrl: `//www.wikidata.org/wiki/Property_talk:${pid}`
            });
        }

        // 2. Property constraints from P2302 claims
        let propDef = schemaProperties[pid] || {};
        let isSchemaSingle = (propDef.max === 1);

        if (meta.constraints && meta.constraints.length > 0) {
            meta.constraints.forEach(c => {
                // Single-value constraint (Q21510865): Only if schema limits to 1 or no scope qualifiers exist
                if (c.isSingle && (isSchemaSingle || !c.hasScopeQualifier) && activeRows.length > 1 && preferredRows.length !== 1) {
                    violations.push({
                        type: 'warning',
                        name: 'single-value constraint',
                        message: `Only one value is allowed for property <a title="Property:${pid}" href="/wiki/Property:${pid}">${meta.label}</a> (or set preferred rank on one value).`,
                        helpUrl: 'https://www.wikidata.org/wiki/Special:MyLanguage/Help:Property_constraints_portal/Q21510865',
                        talkUrl: `//www.wikidata.org/wiki/Property_talk:${pid}`
                    });
                }
                if (c.regex && !isEmpty && typeof row.value === 'string') {
                    try {
                        let reg = new RegExp(c.regex);
                        if (!reg.test(row.value)) {
                            violations.push({
                                type: 'violation',
                                name: 'format constraint',
                                message: `Value "${row.value}" does not match required format pattern (${c.regex}).`,
                                helpUrl: 'https://www.wikidata.org/wiki/Special:MyLanguage/Help:Property_constraints_portal/Q21502404',
                                talkUrl: `//www.wikidata.org/wiki/Property_talk:${pid}`
                            });
                        }
                    } catch (e) {}
                }
                if (c.qid === 'Q21503252') {
                    suggestions.push({
                        type: 'suggestion',
                        name: 'type constraint',
                        message: `Ensure value for <a title="Property:${pid}" href="/wiki/Property:${pid}">${meta.label}</a> matches required entity type.`,
                        helpUrl: 'https://www.wikidata.org/wiki/Special:MyLanguage/Help:Property_constraints_portal/Q21503252',
                        talkUrl: `//www.wikidata.org/wiki/Property_talk:${pid}`
                    });
                }
            });
        }

        return { violations, suggestions };
    }

    /**
     * Updates card borders, badges, and validation summary in real-time.
     */
    function liveUpdateValidation() {
        let val = validateFormState();
        if (Object.keys(schemaProperties).length === 0) return;

        // 1. Update summary box
        let summaryText = mw.msg('cradle-validation-summary', 
            activeSchema ? activeSchema.id : 'Template', 
            val.presentRequired, 
            val.totalRequired, 
            val.presentOptional, 
            val.totalOptional
        );
        let allRequiredSatisfied = (val.presentRequired === val.totalRequired);
        
        $('#cradle-validation-summary-box')
            .css({
                'background-color': allRequiredSatisfied ? 'rgba(0, 175, 137, 0.08)' : 'rgba(211, 51, 51, 0.05)',
                'border-color': allRequiredSatisfied ? 'var(--color-success, #00af89)' : 'var(--color-destructive, #d33)',
                'color': allRequiredSatisfied ? 'var(--color-success, #00af89)' : 'var(--color-destructive, #d33)'
            })
            .text(summaryText);

        // 2. Update each card & row indicators
        Object.keys(val.properties).forEach(pid => {
            let propVal = val.properties[pid];
            let $card = $(`#cradle-card-${pid}`);
            if (!$card.length) return;

            $card.removeClass('valid invalid optional-present optional-missing')
                 .addClass(propVal.itemClass);

            $card.find('.cradle-card-validation-badge').html(propVal.badgeHtml);

            // Update live Wikibase Quality Constraint (wbqc) statement indicators
            let rows = formState[pid] || [];
            rows.forEach(row => {
                let $indicators = $(`#cradle-indicators-${row.id}`);
                if (!$indicators.length) return;
                $indicators.empty();

                let { violations, suggestions } = evaluateRowConstraints(pid, row, rows);
                let hasViolations = violations.length > 0;
                let hasSuggestions = suggestions.length > 0;

                if (hasViolations || hasSuggestions) {
                    let primaryType = hasViolations ? 'warning' : 'suggestion';
                    let iconClass = hasViolations ? 'oo-ui-icon-alert' : 'oo-ui-icon-suggestion-constraint-violation';
                    let titleText = hasViolations ? 'There are some issues with this statement.' : 'There are some suggestions for improving this statement.';

                    let $btn = $('<span>')
                        .addClass(`wbqc-reports-button wikibase-snakview-indicator wbqc-constraint-${primaryType} oo-ui-widget oo-ui-widget-enabled oo-ui-buttonElement oo-ui-buttonElement-frameless oo-ui-buttonElement-size-medium oo-ui-iconElement oo-ui-buttonWidget oo-ui-popupButtonWidget`)
                        .html(`<a class="oo-ui-buttonElement-button" role="button" title="${titleText}"><span class="oo-ui-iconElement-icon ${iconClass}"></span></a>`);

                    $indicators.append($btn);

                    $btn.off('click.wbqc').on('click.wbqc', function(e) {
                        e.stopPropagation();
                        $('.cradle-wbqc-popup').remove();

                        let headerTitle = hasViolations ? 'Issues' : 'Suggestions';

                        let $popup = $('<div>').addClass('oo-ui-widget oo-ui-widget-enabled oo-ui-popupWidget oo-ui-popupWidget-anchored cradle-wbqc-popup')
                            .css({
                                'position': 'absolute',
                                'z-index': '99999',
                                'background': '#ffffff',
                                'border': '1px solid #c8ccd1',
                                'border-radius': '2px',
                                'box-shadow': '0 2px 8px rgba(0,0,0,0.15)',
                                'width': '330px',
                                'padding': '12px',
                                'font-size': '0.85rem'
                            });

                        let $head = $('<div>').addClass('oo-ui-popupWidget-head').css({
                            'display': 'flex',
                            'justify-content': 'space-between',
                            'align-items': 'center',
                            'border-bottom': '1px solid #eaecf0',
                            'padding-bottom': '6px',
                            'margin-bottom': '8px'
                        }).html(`<strong>${headerTitle}</strong> <a class="cradle-popup-close" style="cursor:pointer; font-weight:bold; color:#54595d; text-decoration:none;">✕</a>`);

                        $head.find('.cradle-popup-close').on('click', function() { $popup.remove(); });

                        let $body = $('<div>').addClass('wbqc-reports-all');

                        // Render Violations / Issues section
                        if (hasViolations) {
                            violations.forEach(rep => {
                                let $reportBox = $('<div>').addClass(`wbqc-reports-status-${rep.type} wbqc-report`).css({'margin-bottom': '8px'});
                                let $heading = $('<h4>').addClass('wbqc-report-heading').css({'margin': '0 0 4px 0', 'font-size': '0.85rem'})
                                    .html(`<a href="${rep.helpUrl}" target="_blank">${rep.name}</a> <small class="wbqc-report-heading-links"><a class="wbqc-constraint-type-help" title="Help page" href="${rep.helpUrl}" target="_blank">Help</a> <a class="wbqc-constraint-discuss" title="Discussion page" href="${rep.talkUrl}" target="_blank">Discuss</a></small>`);
                                let $msg = $('<p>').css({'margin': '0', 'font-size': '0.8rem', 'color': '#202122'}).html(rep.message);
                                $reportBox.append($heading).append($msg);
                                $body.append($reportBox);
                            });
                        }

                        // Render Suggestions section
                        if (hasSuggestions) {
                            suggestions.forEach(rep => {
                                let $reportBox = $('<div>').addClass(`wbqc-reports-status-${rep.type} wbqc-report`).css({'margin-bottom': '8px'});
                                let $heading = $('<h4>').addClass('wbqc-report-heading').css({'margin': '0 0 4px 0', 'font-size': '0.85rem'})
                                    .html(`<a href="${rep.helpUrl}" target="_blank">${rep.name}</a> <small class="wbqc-report-heading-links"><a class="wbqc-constraint-type-help" title="Help page" href="${rep.helpUrl}" target="_blank">Help</a> <a class="wbqc-constraint-discuss" title="Discussion page" href="${rep.talkUrl}" target="_blank">Discuss</a></small>`);
                                let $msg = $('<p>').css({'margin': '0', 'font-size': '0.8rem', 'color': '#202122'}).html(rep.message);
                                $reportBox.append($heading).append($msg);
                                $body.append($reportBox);
                            });
                        }

                        $popup.append($head).append($body);

                        let buttonOffset = $btn.offset();
                        let popupWidth = 330;
                        let windowWidth = $(window).width();

                        let leftPos = buttonOffset.left - popupWidth + 30;
                        if (leftPos + popupWidth > windowWidth - 15) {
                            leftPos = windowWidth - popupWidth - 15;
                        }
                        leftPos = Math.max(10, leftPos);

                        $popup.css({
                            'top': (buttonOffset.top + $btn.outerHeight() + 4) + 'px',
                            'left': leftPos + 'px'
                        });

                        $('body').append($popup);
                    });
                }
            });
        });
    }

    /**
     * Updates the drawer footer area (credits and buttons).
     */
    function updateDrawerFooter(showButtons) {
        let $footer = $('#cradle-footer-area').empty();
        if (!$footer.length) return;
 
        if (showButtons) {
            let $btnContainer = $('<div>').css({
                'display': 'flex',
                'gap': '12px',
                'width': '100%',
                'margin-bottom': '8px'
            });
            
            let $saveBtn = $('<button>')
                .addClass('cradle-btn-primary')
                .text(activeMode === 'edit' ? mw.msg('cradle-save-changes') : mw.msg('cradle-create-item'))
                .on('click', saveForm);
                
            let $cancelBtn = $('<button>')
                .addClass('cradle-btn-secondary')
                .text(mw.msg('cradle-cancel'))
                .on('click', function() {
                    if (isSpecialCradle) {
                        renderCreateOptionsSelector();
                    } else {
                        closeEditor();
                    }
                });
 
            $btnContainer.append($cancelBtn).append($saveBtn);
            $footer.append($btnContainer);
        }
 
        if (true) {
            let danielLink = '<a href="' + mw.util.getUrl('User:Danielyepezgarces') + '" target="_blank">Daniel Yepez Garces</a>';
            let ismaelLink = '<a href="' + mw.util.getUrl('User:Olea') + '" target="_blank">Ismael Olea</a>';
            let cradleLink = '<a href="https://cradle.toolforge.org/" target="_blank">Cradle</a>';
            let magnusLink = '<a href="https://meta.wikimedia.org/wiki/User:Magnus_Manske" target="_blank">Magnus Manske</a>';
 
            let $credits = $('<p>')
                .css({
                    'font-size': '0.72rem',
                    'color': 'var(--color-subtle, #54595d)',
                    'margin': '4px auto 0 auto',
                    'text-align': 'center',
                    'width': '100%',
                    'line-height': '1.3'
                })
                .html(mw.msg('cradle-credits', danielLink, ismaelLink, cradleLink, magnusLink));
 
            $footer.append($credits);
        }
    }

    /**
     * Resets active state and goes back to selection menu.
     */
    function changeActiveForm() {
        schemaProperties = {};
        propertyMetadata = {};
        softselectLabels = {};
        formState = {};
        activeSchema = null;
        activeTemplate = null;
        userWantsToChangeSchema = true;
        renderActiveView();
    }

    function renderForm() {
        let $content = $('#cradle-content-area').empty();
        let propIds = sortPropertyIDs(Object.keys(schemaProperties));

        // Render back button
        let $headerPanel = $('<div>').css({'display': 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '16px'});
        $headerPanel.append($('<button>').addClass('cradle-btn-secondary').html(ICONS.back + ' <span>' + mw.msg('cradle-change-form') + '</span>').on('click', changeActiveForm));
        $content.append($headerPanel);

        // Display current active schema/template title
        if (activeTemplate) {
            let activeTitle = activeTemplate.labels[mw.config.get('wgUserLanguage')] || activeTemplate.title;
            let $formHeader = $('<div>').css({'margin-bottom': '20px', 'padding-bottom': '8px'})
                .append($('<h2>').css({
                    'font-size': '1.25rem',
                    'margin': '0',
                    'font-weight': 'bold',
                    'color': 'var(--color-base, #202122)'
                }).text(activeTitle));
            $content.append($formHeader);
        } else if (activeSchema) {
            let schemaUrl = mw.util.getUrl('EntitySchema:' + activeSchema.id);
            let schemaText = (activeSchema.label && activeSchema.label !== activeSchema.id)
                ? `${activeSchema.label} (${activeSchema.id})`
                : activeSchema.id;

            let $schemaLink = $('<a>')
                .attr({
                    'href': schemaUrl,
                    'target': '_blank',
                    'title': 'EntitySchema:' + activeSchema.id
                })
                .css({
                    'color': 'var(--color-link, #36c)',
                    'text-decoration': 'none'
                })
                .text(schemaText)
                .hover(
                    function() { $(this).css('text-decoration', 'underline'); },
                    function() { $(this).css('text-decoration', 'none'); }
                );

            let $h2 = $('<h2>').css({
                'font-size': '1.25rem',
                'margin': '0',
                'font-weight': 'bold',
                'color': 'var(--color-base, #202122)'
            }).append($schemaLink);

            $content.append($('<div>').css({'margin-bottom': '20px', 'padding-bottom': '8px'}).append($h2));
        }

        // Live validation summary banner at the top of the form
        let $summaryBox = $('<div>')
            .attr('id', 'cradle-validation-summary-box')
            .css({
                'padding': '12px 16px',
                'border-radius': '2px',
                'margin-bottom': '16px',
                'font-size': '0.9rem',
                'font-weight': 'bold',
                'border': '1px solid transparent',
                'transition': 'all 0.2s ease'
            });
        $content.append($summaryBox);

        // For Create Mode: Render Multilingual Identity Card (allowing 1 or more languages)
        if (activeMode === 'create') {
            let $metaCard = $('<div>').addClass('cradle-field-card').addClass('mandatory');
            let $title = $('<h3>').addClass('cradle-field-title').text(mw.msg('cradle-new-item-identity'));
            $title.append($('<span>').addClass('cradle-field-required-marker').text(' *'));
            $metaCard.append($title);
            $metaCard.append($('<p>').addClass('cradle-field-description').text(mw.msg('cradle-new-item-identity-desc')));

            let $langRowsContainer = $('<div>').attr('id', 'cradle-lang-rows-container').css({
                'display': 'flex',
                'flex-direction': 'column',
                'gap': '8px',
                'margin-bottom': '8px'
            });

            function createLanguageRow(defaultLang) {
                let $row = $('<div>').addClass('cradle-identity-lang-row').css({
                    'display': 'flex',
                    'flex-direction': 'row',
                    'gap': '8px',
                    'align-items': 'center'
                });

                // 1. Language search input
                let $langWrapper = $('<div>').css({'flex': '0 0 95px', 'position': 'relative'});
                let $langInput = $('<input>')
                    .addClass('cradle-input')
                    .addClass('cradle-lang-input')
                    .attr({
                        'type': 'text',
                        'placeholder': 'Lang'
                    })
                    .css({'width': '100%'})
                    .val(defaultLang || mw.config.get('wgUserLanguage') || 'en');
                    
                setupLanguageAutocomplete($langInput);
                $langWrapper.append($langInput);

                // 2. Label input
                let $labelInput = $('<input>')
                    .addClass('cradle-input')
                    .addClass('cradle-label-input')
                    .attr({
                        'type': 'text',
                        'placeholder': mw.msg('cradle-new-item-label')
                    })
                    .css({'flex': '1', 'min-width': '130px'});

                // 3. Description input
                let $descInput = $('<input>')
                    .addClass('cradle-input')
                    .addClass('cradle-desc-input')
                    .attr({
                        'type': 'text',
                        'placeholder': mw.msg('cradle-new-item-desc')
                    })
                    .css({'flex': '1.4', 'min-width': '150px'});

                // 4. Aliases input
                let $aliasesInput = $('<input>')
                    .addClass('cradle-input')
                    .addClass('cradle-aliases-input')
                    .attr({
                        'type': 'text',
                        'placeholder': mw.msg('cradle-new-item-aliases')
                    })
                    .css({'flex': '1', 'min-width': '130px'});

                // Remove button for secondary languages
                let $removeBtn = $('<button>')
                    .addClass('cradle-btn-delete')
                    .html(ICONS.close)
                    .attr('title', 'Eliminar idioma')
                    .css({'height': '36px', 'width': '36px', 'padding': '0', 'flex-shrink': '0'})
                    .on('click', function() {
                        if ($langRowsContainer.children().length > 1) {
                            $row.remove();
                        } else {
                            mw.notify('Debe haber al menos un idioma.', { type: 'warn' });
                        }
                    });

                $row.append($langWrapper).append($labelInput).append($descInput).append($aliasesInput).append($removeBtn);
                return $row;
            }

            $langRowsContainer.append(createLanguageRow(mw.config.get('wgUserLanguage') || 'es'));

            let $addLangBtn = $('<button>')
                .addClass('cdx-button cdx-button--weight-quiet')
                .css({'color': '#36c', 'font-size': '0.85rem', 'padding': '4px 8px'})
                .html(ICONS.plus + ' <span>' + mw.msg('cradle-add-language') + '</span>')
                .on('click', function(e) {
                    e.preventDefault();
                    let nextLang = $langRowsContainer.children().length === 1 ? (mw.config.get('wgUserLanguage') === 'es' ? 'en' : 'es') : '';
                    $langRowsContainer.append(createLanguageRow(nextLang));
                });

            $metaCard.append($langRowsContainer).append($addLangBtn);
            $content.append($metaCard);
        }

        // Render properties inside cradle-wikibase-statementgrouplistview
        let $groupList = $('<div>').addClass('cradle-wikibase-statementgrouplistview');
        $content.append($groupList);

        propIds.forEach(pid => {
            let propDef = schemaProperties[pid];
            let meta = propertyMetadata[pid] || { label: pid, description: '', datatype: 'string' };
            
            let $card = $('<div>')
                .addClass('cradle-wikibase-statementgroupview')
                .attr({'id': `cradle-card-${pid}`, 'data-property-id': pid});
                
            let $propCol = $('<div>').addClass('cradle-wikibase-statementgroupview-property');
            let $labelDiv = $('<div>').addClass('cradle-wikibase-statementgroupview-property-label').attr('dir', 'auto');
            
            let $badge = $('<span>').addClass('cradle-card-validation-badge');
            $labelDiv.append($badge);
            $labelDiv.append($('<a>').attr({
                href: `/wiki/Property:${pid}`,
                target: '_blank'
            }).text(meta.label));

            $labelDiv.append($('<span>').addClass('cradle-prop-pid').text(pid + (propDef.mandatory ? ' *' : '')));
            if (meta.description) {
                $labelDiv.append($('<span>').addClass('cradle-prop-desc').text(meta.description));
            }
            $propCol.append($labelDiv);

            let $stmtList = $('<div>').addClass('cradle-wikibase-statementlistview');
            let $rowsContainer = $('<div>').addClass('cradle-wikibase-statementlistview-listview').attr('id', `cradle-rows-${pid}`);
            let $actionsContainer = $('<div>').addClass('cradle-wikibase-toolbar-wrapper').attr('id', `cradle-actions-${pid}`);

            $stmtList.append($rowsContainer).append($actionsContainer);
            $card.append($propCol).append($stmtList);
            $groupList.append($card);

            renderPropertyRows(pid);
        });

        updateDrawerFooter(true);
        liveUpdateValidation();
    }

    /**
     * Formats any Wikibase snak object, datavalue, QID, string or date into a human-readable text value.
     */
    function formatSnakValue(snak) {
        if (snak === null || snak === undefined) return '';
        if (typeof snak === 'string' || typeof snak === 'number') {
            let strVal = String(snak).trim();
            if (/^[QP]\d+$/i.test(strVal) && softselectLabels[strVal]) {
                return `${softselectLabels[strVal]} (${strVal})`;
            }
            return strVal;
        }

        let dv = snak.datavalue ? snak.datavalue : (snak.value !== undefined ? { value: snak.value, type: snak.datatype } : null);
        if (dv) {
            let val = dv.value;
            let type = dv.type || snak.datatype || typeof val;

            if (typeof val === 'string') {
                if (/^[QP]\d+$/i.test(val) && softselectLabels[val]) {
                    return `${softselectLabels[val]} (${val})`;
                }
                return val;
            }
            if (typeof val === 'object' && val !== null) {
                if (val['entity-type'] || val.id) {
                    let qid = val.id || (val['numeric-id'] ? `Q${val['numeric-id']}` : '');
                    if (qid) {
                        return softselectLabels[qid] ? `${softselectLabels[qid]} (${qid})` : qid;
                    }
                }
                if (val.time) {
                    let timeStr = val.time.replace(/^\+/, '');
                    if (timeStr.includes('T')) {
                        timeStr = timeStr.split('T')[0];
                    }
                    return timeStr;
                }
                if (val.amount !== undefined) {
                    let amt = val.amount.replace(/^\+/, '');
                    let unit = val.unit && val.unit.includes('Q') ? ` (${val.unit.split('/').pop()})` : '';
                    return amt + unit;
                }
                if (val.text) {
                    return val.text + (val.language ? ` [${val.language}]` : '');
                }
                if (val.latitude !== undefined && val.longitude !== undefined) {
                    return `${val.latitude}°, ${val.longitude}°`;
                }
            }
        }

        if (typeof snak === 'object') {
            if (snak.text) return snak.text;
            if (snak.id) return softselectLabels[snak.id] ? `${softselectLabels[snak.id]} (${snak.id})` : snak.id;
            if (snak.time) return snak.time;
            if (snak.label) return snak.label;
        }

        return String(snak);
    }

    /**
     * Render statement rows for a given property.
     */
    function renderPropertyRows(pid) {
        let $container = $(`#cradle-rows-${pid}`).empty();
        let $actionsContainer = $(`#cradle-actions-${pid}`).empty();
        let propDef = schemaProperties[pid];
        
        let rows = formState[pid];

        rows.forEach((row, index) => {
            let $row = $('<div>')
                .addClass('cradle-wikibase-statementview cradle-listview-item')
                .attr('id', `cradle-row-${row.id}`);

            if (row.isDeleted) {
                $row.addClass('deleted');
            }

            // 1. Rank Selector Column
            let $rankWrapper = $('<div>').addClass('cradle-wikibase-statementview-rankselector');
            let $rankUp = $('<span>').addClass('cradle-rank-up').text('▵').attr('title', 'Aumentar rango').on('click', function() {
                row.rank = row.rank === 'normal' ? 'preferred' : (row.rank === 'deprecated' ? 'normal' : 'preferred');
                renderPropertyRows(pid);
            });
            let rankChar = row.rank === 'preferred' ? '★' : (row.rank === 'deprecated' ? '▼' : '●');
            let $rankCircle = $('<span>').addClass('cradle-rank-circle').text(rankChar);
            let $rankDown = $('<span>').addClass('cradle-rank-down').text('▿').attr('title', 'Disminuir rango').on('click', function() {
                row.rank = row.rank === 'normal' ? 'deprecated' : (row.rank === 'preferred' ? 'normal' : 'deprecated');
                renderPropertyRows(pid);
            });
            $rankWrapper.append($rankUp).append($rankCircle).append($rankDown);
            $row.append($rankWrapper);

            // 2. Mainsnak Container
            let $mainsnakContainer = $('<div>').addClass('cradle-wikibase-statementview-mainsnak-container');
            let $mainsnak = $('<div>').addClass('cradle-wikibase-statementview-mainsnak');
            let $snakview = $('<div>').addClass('cradle-wikibase-snakview cradle-wb-edit');
            let $snakValueContainer = $('<div>').addClass('cradle-wikibase-snakview-value-container');
            let $snakBody = $('<div>').addClass('cradle-wikibase-snakview-body');
            let $snakValue = $('<div>').addClass('cradle-wikibase-snakview-value');
            let $valueView = $('<div>').addClass('cradle-valueview-value');
            
            let $inputElem = createInputForDatatype(pid, row);
            $valueView.append($inputElem);
            $snakValue.append($valueView);
            $snakBody.append($snakValue);
            $snakValueContainer.append($snakBody);
            $snakview.append($snakValueContainer);
            $mainsnak.append($snakview);
            $mainsnakContainer.append($mainsnak);

            // Collect missing PIDs and QIDs from qualifiers and references to pre-fetch metadata & labels
            let missingPidsToFetch = [];
            let missingQidsToFetch = [];

            // 1. Render Qualifiers Section if qualifiers exist or are defined
            let $qualBox = $('<div>').addClass('cradle-wikibase-qualifiers');
            let qualPids = Object.keys(row.qualifiers || {});
            if (qualPids.length > 0 || (propDef && propDef.qualifiers && propDef.qualifiers.length > 0)) {
                let displayQualPids = qualPids.length > 0 ? qualPids : (propDef.qualifiers || []);
                displayQualPids.forEach(qPid => {
                    if (!propertyMetadata[qPid] || !propertyMetadata[qPid].label || propertyMetadata[qPid].label === qPid) {
                        missingPidsToFetch.push(qPid);
                    }
                    let qMeta = propertyMetadata[qPid] || { label: qPid };
                    let qVals = (row.qualifiers && row.qualifiers[qPid]) ? row.qualifiers[qPid] : [''];
                    qVals.forEach((qVal, qIdx) => {
                        let formattedVal = formatSnakValue(qVal);
                        
                        let qidCandidate = typeof qVal === 'string' ? qVal : (qVal && qVal.id ? qVal.id : (qVal && qVal.datavalue && qVal.datavalue.value ? qVal.datavalue.value.id : null));
                        if (qidCandidate && /^[QP]\d+$/i.test(qidCandidate) && !softselectLabels[qidCandidate]) {
                            missingQidsToFetch.push(qidCandidate);
                        }

                        let $qRow = $('<div>').addClass('cradle-qualifier-row').attr('data-qpid', qPid);
                        let $qProp = $('<div>').addClass('cradle-qualifier-prop').text(qMeta.label || qPid);
                        let $qValDiv = $('<div>').addClass('cradle-qualifier-val');
                        let $qInput = $('<input>')
                            .addClass('cradle-input')
                            .attr('type', 'text')
                            .val(formattedVal)
                            .on('change input', function() {
                                if (!row.qualifiers) row.qualifiers = {};
                                row.qualifiers[qPid] = [$(this).val()];
                                liveUpdateValidation();
                            });
                        $qValDiv.append($qInput);
                        $qRow.append($qProp).append($qValDiv);
                        $qualBox.append($qRow);
                    });
                });
                $mainsnakContainer.append($qualBox);
            }

            // 2. Render References Section
            let $refBox = $('<div>').addClass('cradle-wikibase-references');
            let refList = row.references || [];
            let refCount = refList.length;
            let $refHeader = $('<div>').addClass('cradle-reference-header')
                .text(refCount > 0 ? `▼ ${refCount} referencia(s)` : '▶ 0 referencias');
            
            let $refContent = $('<div>').css({'display': refCount > 0 ? 'block' : 'none'});
            $refHeader.on('click', function() {
                $refContent.toggle();
                $(this).text($refContent.is(':visible') ? `▼ ${row.references.length} referencia(s)` : `▶ ${row.references.length} referencias`);
            });

            refList.forEach((refObj, rIdx) => {
                let refSnaks = refObj.snaks || refObj;
                Object.keys(refSnaks).forEach(rPid => {
                    if (!propertyMetadata[rPid] || !propertyMetadata[rPid].label || propertyMetadata[rPid].label === rPid) {
                        missingPidsToFetch.push(rPid);
                    }
                    let rMeta = propertyMetadata[rPid] || { label: rPid };
                    let snakArr = Array.isArray(refSnaks[rPid]) ? refSnaks[rPid] : [refSnaks[rPid]];
                    snakArr.forEach(s => {
                        let formattedRefVal = formatSnakValue(s);
                        let rQidCandidate = typeof s === 'string' ? s : (s && s.id ? s.id : (s && s.datavalue && s.datavalue.value ? (s.datavalue.value.id || (s.datavalue.value['numeric-id'] ? `Q${s.datavalue.value['numeric-id']}` : null)) : null));
                        if (rQidCandidate && /^[QP]\d+$/i.test(rQidCandidate) && !softselectLabels[rQidCandidate]) {
                            missingQidsToFetch.push(rQidCandidate);
                        }

                        let $rRow = $('<div>').addClass('cradle-reference-row').attr('data-rpid', rPid);
                        let $rProp = $('<div>').addClass('cradle-reference-prop').text(rMeta.label || rPid);
                        let $rVal = $('<div>').addClass('cradle-reference-val').text(formattedRefVal);
                        $rRow.append($rProp).append($rVal);
                        $refContent.append($rRow);
                    });
                });
            });

            let $addRefLink = $('<a>').addClass('cradle-add-reference-link').text('+ ' + (mw.msg('cradle-add-reference') || 'añadir referencia'))
                .on('click', function(e) {
                    e.preventDefault();
                    if (!row.references) row.references = [];
                    row.references.push({ snaks: { P248: [{ datavalue: { value: '' } }] } });
                    renderPropertyRows(pid);
                });

            $refBox.append($refHeader).append($refContent).append($addRefLink);
            $mainsnakContainer.append($refBox);

            // Fetch missing property metadata (PIDs) and item labels (QIDs) in parallel for user's language
            let loadPromises = [];
            if (missingPidsToFetch.length > 0) {
                let uniquePids = [...new Set(missingPidsToFetch)];
                loadPromises.push(loadPropertiesMetadata(uniquePids).then(newMeta => {
                    Object.assign(propertyMetadata, newMeta);
                }));
            }
            if (missingQidsToFetch.length > 0) {
                let uniqueQids = [...new Set(missingQidsToFetch)];
                loadPromises.push(loadItemLabels(uniqueQids).then(newLabels => {
                    Object.assign(softselectLabels, newLabels);
                }));
            }

            if (loadPromises.length > 0) {
                Promise.all(loadPromises).then(() => {
                    $qualBox.find('.cradle-qualifier-row').each(function() {
                        let qPid = $(this).attr('data-qpid');
                        if (qPid && propertyMetadata[qPid] && propertyMetadata[qPid].label) {
                            $(this).find('.cradle-qualifier-prop').text(propertyMetadata[qPid].label);
                        }
                    });
                    $refContent.find('.cradle-reference-row').each(function() {
                        let rPid = $(this).attr('data-rpid');
                        if (rPid && propertyMetadata[rPid] && propertyMetadata[rPid].label) {
                            $(this).find('.cradle-reference-prop').text(propertyMetadata[rPid].label);
                        }
                        let valElem = $(this).find('.cradle-reference-val');
                        let txt = valElem.text();
                        if (/^[QP]\d+$/i.test(txt) && softselectLabels[txt]) {
                            valElem.text(`${softselectLabels[txt]} (${txt})`);
                        }
                    });
                });
            }

            $row.append($mainsnakContainer);

            // 3. Toolbar Container with Edit and Delete buttons
            let $toolbarContainer = $('<div>').addClass('cradle-wikibase-toolbar-container');
            let $editBtn = $('<button>')
                .addClass('cradle-btn-icon')
                .html('✏️')
                .attr('title', mw.msg('cradle-edit-tab') || 'Editar')
                .on('click', function() {
                    let $inp = $valueView.find('input, select, textarea').first();
                    if ($inp.length) $inp.focus().select();
                });
            let $deleteBtn = $('<button>')
                .addClass('cradle-btn-icon')
                .html(row.isDeleted ? ICONS.undo : ICONS.trash)
                .attr('title', row.isDeleted ? 'Restaurar' : 'Eliminar')
                .on('click', function() {
                    toggleDeleteRow(pid, row.id);
                });
            $toolbarContainer.append($editBtn).append($deleteBtn);
            $row.append($toolbarContainer);

            $container.append($row);
        });

        // Dynamic Action Bar rendering (Add row button)
        let nonDeletedRows = rows.filter(r => !r.isDeleted);
        let maxLimit = propDef.max;
        let showAddButton = (maxLimit === '*' || maxLimit === Infinity || nonDeletedRows.length < maxLimit);

        if (showAddButton) {
            let $addBtn = $('<a>')
                .addClass('cradle-addstatement-link')
                .html(`+ ${mw.msg('cradle-add-value')}`)
                .on('click', function(e) {
                    e.preventDefault();
                    addRow(pid);
                });
            $actionsContainer.append($addBtn);
        }
    }

    /**
     * Creates appropriate jQuery inputs for a datatype.
     */
    function createInputForDatatype(pid, row) {
        let propDef = schemaProperties[pid] || {};
        
        // Support for dropdown select when predefined values / hardselect / softselect / allowedValues exist
        let allowedList = propDef.hardselect || propDef.softselect || propDef.allowedValues || propDef.values;
        if (allowedList && Array.isArray(allowedList) && allowedList.length > 0) {
            let $select = $('<select>').addClass('cradle-select').css({
                'width': '100%',
                'height': '32px',
                'padding': '4px 6px',
                'border': '1px solid #a2a9b1',
                'border-radius': '2px',
                'font-size': '0.875rem'
            });
            
            function buildOptions() {
                $select.empty().append($('<option>').val('').text('-- ' + (mw.msg('cradle-select') || 'Seleccionar') + ' --'));
                allowedList.forEach(opt => {
                    let optVal = typeof opt === 'object' ? (opt.id || opt.value) : opt;
                    let optLabel = typeof opt === 'object' ? (opt.label || opt.name || optVal) : (softselectLabels[optVal] || optVal);
                    let labelText = (optLabel && optLabel !== optVal) ? `${optLabel} (${optVal})` : optVal;
                    $select.append($('<option>').val(optVal).text(labelText));
                });
                if (row.value) {
                    $select.val(typeof row.value === 'object' ? row.value.id : row.value);
                }
            }

            buildOptions();
            $select.on('change', function() {
                row.value = $select.val();
                liveUpdateValidation();
            });
            return $select;
        }

        // 1. wikibase-item & wikibase-property datatype
        if (row.datatype === 'wikibase-item' || row.datatype === 'wikibase-property') {
            if (propDef && propDef.hardselect && propDef.hardselect.length > 0) {
                let $select = $('<select>').addClass('cradle-select');
                
                function getAllQids() {
                    let qidList = [...propDef.hardselect];
                    if (row.value && typeof row.value === 'string' && /^[QP]\d+$/i.test(row.value) && !qidList.includes(row.value)) {
                        qidList.push(row.value);
                    }
                    return qidList;
                }

                function buildOptions() {
                    let qidList = getAllQids();
                    $select.empty().append($('<option>').val('').text('-- Select --'));
                    qidList.forEach(qid => {
                        let label = softselectLabels[qid] || qid;
                        let text = (label && label !== qid) ? `${label} (${qid})` : qid;
                        $select.append($('<option>').val(qid).text(text));
                    });
                    $select.val(row.value);
                }

                buildOptions();

                let allQids = getAllQids();
                let missingQids = allQids.filter(qid => !softselectLabels[qid]);
                if (missingQids.length > 0) {
                    loadItemLabels(missingQids).then(labels => {
                        Object.assign(softselectLabels, labels);
                        buildOptions();
                    });
                }
                
                $select.on('change', function() {
                    row.value = $select.val();
                    liveUpdateValidation();
                });
                return $select;
            }

            let $wrapper = $('<div>').addClass('cradle-autocomplete-wrapper').css({'flex': '1'});
            let $input = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('placeholder', mw.msg('cradle-search-placeholder'))
                .val('');

            let $dropdown = $('<ul>').addClass('cradle-autocomplete-dropdown').hide();
            $wrapper.append($input).append($dropdown);

            function setSelectedItemUI(id, label) {
                row.value = id;
                if (label && label !== id) {
                    $input.val(`${label} (${id})`);
                } else {
                    $input.val(id);
                }
            }

            if (row.value) {
                loadItemLabels([row.value]).then(labels => {
                    if (labels[row.value]) {
                        setSelectedItemUI(row.value, labels[row.value]);
                    } else {
                        setSelectedItemUI(row.value, row.value);
                    }
                });
            }

            let searchTimeout = null;

            function showSoftselectOptions() {
                let optionsList = [];
                if (propDef && propDef.softselect && propDef.softselect.length > 0) {
                    optionsList = [...propDef.softselect];
                }
                if (row.value && typeof row.value === 'string' && /^[QP]\d+$/i.test(row.value) && !optionsList.includes(row.value)) {
                    optionsList.push(row.value);
                }

                // Filter out QIDs that are already selected in other non-deleted rows of the same property
                let otherRows = (formState[pid] || []).filter(r => r.id !== row.id && !r.isDeleted);
                let usedQids = otherRows.map(r => typeof r.value === 'string' ? r.value.trim().toUpperCase() : '').filter(v => /^[QP]\d+$/i.test(v));
                
                optionsList = optionsList.filter(qid => !usedQids.includes(qid.toUpperCase()));

                if (optionsList.length > 0) {
                    loadItemDetails(optionsList).then(details => {
                        $dropdown.empty();
                        optionsList.forEach(qid => {
                            let item = details[qid] || { label: qid, description: '' };
                            let $r = $('<li>').addClass('cradle-autocomplete-row').css({'padding': '6px 8px', 'cursor': 'pointer'});
                            let $lbl = $('<div>').addClass('cradle-autocomplete-row-label').text(item.label);
                            $lbl.append($('<small>').css({'color': 'var(--color-subtle, #54595d)', 'margin-left': '6px'}).text(`(${qid})`));
                            $r.append($lbl);
                            if (item.description) {
                                $r.append($('<div>').addClass('cradle-autocomplete-row-desc').css({'font-size': '0.75rem', 'color': 'var(--color-subtle, #54595d)'}).text(item.description));
                            }
                            $r.on('click mousedown', function(e) {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedItemUI(qid, item.label);
                                $dropdown.hide();
                                liveUpdateValidation();
                            });
                            $dropdown.append($r);
                        });
                        $dropdown.show();
                    });
                } else {
                    $dropdown.empty().hide();
                }
            }

            $input.on('focus', function() {
                let currentVal = $input.val();
                let cleanLabel = currentVal.replace(/\s*\([QP]\d+\)$/i, '');
                $input.val(cleanLabel);
                setTimeout(function() { $input.select(); }, 50);

                if (!$input.val().trim() || $input.val().trim().length < 2) {
                    showSoftselectOptions();
                }
            });

            $input.on('blur', function() {
                if (row.value && row.value.match(/^[QP]\d+$/i)) {
                    loadItemLabels([row.value]).then(labels => {
                        let label = labels[row.value] || row.value;
                        if (label && label !== row.value) {
                            $input.val(`${label} (${row.value})`);
                        } else {
                            $input.val(row.value);
                        }
                    });
                }
            });

            $input.on('input', function() {
                let query = $input.val().trim();
                
                if (/^[qQpP]\d+$/.test(query)) {
                    let id = query.toUpperCase();
                    row.value = id;
                    loadItemLabels([id]).then(labels => {
                        if (labels[id]) {
                            setSelectedItemUI(id, labels[id]);
                        } else {
                            setSelectedItemUI(id, id);
                        }
                    });
                } else if (!query) {
                    row.value = '';
                }
                liveUpdateValidation();
                
                clearTimeout(searchTimeout);
                if (query.length < 2) {
                    showSoftselectOptions();
                    return;
                }

                searchTimeout = setTimeout(function() {
                    searchWikidataItems(query).then(results => {
                        $dropdown.empty();
                        if (results.length === 0) {
                            $dropdown.hide();
                            return;
                        }
                        
                        results.forEach(res => {
                            let $r = $('<li>').addClass('cradle-autocomplete-row').css({'padding': '6px 8px', 'cursor': 'pointer'});
                            let $lbl = $('<div>').addClass('cradle-autocomplete-row-label').text(res.label || res.id);
                            $lbl.append($('<small>').css({'color': 'var(--color-subtle, #54595d)', 'margin-left': '6px'}).text(`(${res.id})`));
                            $r.append($lbl);
                            if (res.description) {
                                $r.append($('<div>').addClass('cradle-autocomplete-row-desc').css({'font-size': '0.75rem', 'color': 'var(--color-subtle, #54595d)'}).text(res.description));
                            }
                            
                            $r.on('click mousedown', function(e) {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedItemUI(res.id, res.label || res.id);
                                $dropdown.hide();
                                liveUpdateValidation();
                            });
                            
                            $dropdown.append($r);
                        });
                        $dropdown.show();
                    });
                }, 300);
            });

            $(document).on('click.cradleItemAutocomplete', function(e) {
                if (!$wrapper.is(e.target) && $wrapper.has(e.target).length === 0) {
                    $dropdown.hide();
                }
            });

            return $wrapper;
        }

        // 2. monolingualtext datatype
        if (row.datatype === 'monolingualtext') {
            let $group = $('<div>').css({'display': 'flex', 'gap': '8px', 'flex': '1'});
            let valObj = row.value || { text: '', language: mw.config.get('wgUserLanguage') || 'en' };
            
            let $langInput = $('<input>')
                .addClass('cradle-input')
                .addClass('cradle-lang-input')
                .attr('type', 'text')
                .attr('placeholder', 'Lang')
                .val(valObj.language);
                
            let $textInput = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('placeholder', 'Text')
                .css({'flex': '1'})
                .val(valObj.text);

            $group.append($langInput).append($textInput);

            setupLanguageAutocomplete($langInput, function(selectedCode) {
                valObj.language = selectedCode;
                row.value = valObj;
                liveUpdateValidation();
            });

            $langInput.on('input', function() {
                valObj.language = $langInput.val().trim();
                row.value = valObj;
                liveUpdateValidation();
            });
            $textInput.on('input', function() {
                valObj.text = $textInput.val();
                row.value = valObj;
                liveUpdateValidation();
            });

            return $group;
        }

        // 2b. commonsMedia datatype (e.g. P18 image, P154 logo, P94 coat of arms)
        if (row.datatype === 'commonsMedia') {
            let $wrapper = $('<div>').addClass('cradle-autocomplete-wrapper').css({'flex': '1'});
            let $input = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('placeholder', 'e.g. Example.jpg or search Commons...')
                .val(row.value);

            let $dropdown = $('<ul>').addClass('cradle-autocomplete-dropdown').hide();
            $wrapper.append($input).append($dropdown);

            let searchTimeout = null;
            $input.on('input', function() {
                let query = $input.val().trim();
                let cleanQuery = query.replace(/^File:/i, '');
                row.value = cleanQuery;
                liveUpdateValidation();

                clearTimeout(searchTimeout);
                if (query.length < 2) {
                    $dropdown.hide();
                    return;
                }

                searchTimeout = setTimeout(function() {
                    let apiUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(query) + '&gsrnamespace=6&prop=pageimages|info&piprop=thumbnail&pithumbsize=80&format=json&origin=*';
                    $.getJSON(apiUrl).done(function(res) {
                        $dropdown.empty();
                        let pages = (res && res.query && res.query.pages) ? Object.values(res.query.pages) : [];
                        if (pages.length === 0) {
                            $dropdown.hide();
                            return;
                        }
                        pages.sort((a, b) => (a.index || 0) - (b.index || 0));

                        pages.slice(0, 10).forEach(page => {
                            let cleanTitle = (page.title || '').replace(/^File:/i, '');
                            let thumbUrl = page.thumbnail ? page.thumbnail.source : null;

                            let $row = $('<li>').addClass('cradle-autocomplete-row').css({
                                'display': 'flex',
                                'align-items': 'center',
                                'flex-direction': 'row',
                                'gap': '10px',
                                'padding': '6px 8px',
                                'cursor': 'pointer'
                            });

                            let $thumb = $('<div>').css({
                                'width': '40px',
                                'height': '40px',
                                'flex-shrink': '0',
                                'display': 'flex',
                                'align-items': 'center',
                                'justify-content': 'center',
                                'background': '#f8f9fa',
                                'border': '1px solid #eaecf0',
                                'border-radius': '2px'
                            });

                            if (thumbUrl) {
                                $thumb.append($('<img>').attr('src', thumbUrl).css({
                                    'max-width': '40px',
                                    'max-height': '40px',
                                    'object-fit': 'contain'
                                }));
                            }
                            $row.append($thumb);

                            let $nameSpan = $('<span>').addClass('cradle-autocomplete-row-label').css({
                                'font-size': '0.825rem',
                                'word-break': 'break-all',
                                'flex': '1'
                            }).text(cleanTitle);

                            $row.append($nameSpan);

                            $row.on('click mousedown', function(e) {
                                e.preventDefault();
                                e.stopPropagation();
                                row.value = cleanTitle;
                                $input.val(cleanTitle);
                                $dropdown.hide();
                                liveUpdateValidation();
                            });
                            $dropdown.append($row);
                        });
                        $dropdown.show();
                    }).fail(function() {
                        $dropdown.hide();
                    });
                }, 300);
            });

            $(document).on('click.cradleCommonsMedia', function(e) {
                if (!$(e.target).closest($wrapper).length) {
                    $dropdown.hide();
                }
            });

            return $wrapper;
        }

        // 3. quantity datatype
        if (row.datatype === 'quantity') {
            let $input = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'number')
                .attr('placeholder', 'Number value')
                .val(row.value);
                
            $input.on('input', function() {
                row.value = $input.val();
                liveUpdateValidation();
            });
            return $input;
        }

        // 4. time datatype
        if (row.datatype === 'time') {
            let $input = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('placeholder', 'YYYY-MM-DD or YYYY')
                .val(row.value);
                
            $input.on('input', function() {
                row.value = $input.val();
                liveUpdateValidation();
            });
            return $input;
        }

        // 5. Fallback text input (string, external-id, url, etc.)
        let $input = $('<input>')
            .addClass('cradle-input')
            .attr('type', 'text')
            .attr('placeholder', `Enter value`)
            .val(row.value);

        $input.on('input', function() {
            row.value = $input.val();
            liveUpdateValidation();
        });
        return $input;
    }

    /**
     * Add new blank row to property values list.
     */
    function addRow(pid) {
        let meta = propertyMetadata[pid] || { datatype: 'string' };
        formState[pid].push(createNewRowState(meta.datatype));
        renderPropertyRows(pid);
        liveUpdateValidation();
    }

    /**
     * Toggle delete state on row.
     */
    function toggleDeleteRow(pid, rowId) {
        let index = formState[pid].findIndex(r => r.id === rowId);
        if (index === -1) return;

        let row = formState[pid][index];
        if (row.guid === null) {
            formState[pid].splice(index, 1);
        } else {
            row.isDeleted = !row.isDeleted;
        }
        renderPropertyRows(pid);
        liveUpdateValidation();
    }

    /**
     * Search wikidata items.
     */
        /**
     * Search EntitySchemas by label, description, or ID.
     */
    function searchEntitySchemas(term) {
        logDebug("[Cradle] Searching EntitySchemas in namespace 640 for:", term);
        return new Promise((resolve) => {
            let api = new mw.Api();
            let userLang = mw.config.get('wgUserLanguage') || 'en';

            function fetchLabelsForSchemas(schemaIds, rawDescriptionsMap) {
                if (!schemaIds || schemaIds.length === 0) return Promise.resolve([]);
                schemaIds = [...new Set(schemaIds)].slice(0, 10);
                let titlesParam = schemaIds.map(id => 'EntitySchema:' + id).join('|');

                return new Promise((resResolve) => {
                    api.get({
                        action: 'query',
                        prop: 'revisions',
                        titles: titlesParam,
                        rvslots: 'main',
                        rvprop: 'content',
                        format: 'json'
                    }).done(function(queryRes) {
                        let finalResults = [];
                        let pages = (queryRes && queryRes.query && queryRes.query.pages) || {};

                        let schemaMap = {};
                        Object.keys(pages).forEach(pageId => {
                            let p = pages[pageId];
                            if (p.revisions && p.revisions[0] && p.revisions[0].slots && p.revisions[0].slots.main) {
                                try {
                                    let raw = p.revisions[0].slots.main['*'];
                                    let parsed = JSON.parse(raw);
                                    if (parsed && parsed.id) {
                                        schemaMap[parsed.id.toUpperCase()] = parsed;
                                    }
                                } catch(e) {}
                            }
                        });

                        schemaIds.forEach(id => {
                            let parsed = schemaMap[id];
                            let label = id;
                            let desc = rawDescriptionsMap[id] || '';

                            if (parsed) {
                                if (parsed.labels) {
                                    label = (typeof parsed.labels[userLang] === 'string' && parsed.labels[userLang]) ||
                                            (typeof parsed.labels['en'] === 'string' && parsed.labels['en']) ||
                                            id;
                                }
                                if (parsed.descriptions) {
                                    desc = (typeof parsed.descriptions[userLang] === 'string' && parsed.descriptions[userLang]) ||
                                           (typeof parsed.descriptions['en'] === 'string' && parsed.descriptions['en']) ||
                                           desc;
                                }
                            }

                            finalResults.push({
                                id: id,
                                label: label,
                                description: desc
                            });
                        });
                        resResolve(finalResults);
                    }).fail(function() {
                        let fallbackResults = schemaIds.map(id => ({
                            id: id,
                            label: id,
                            description: rawDescriptionsMap[id] || ''
                        }));
                        resResolve(fallbackResults);
                    });
                });
            }

            api.get({
                action: 'opensearch',
                search: term,
                namespace: 640,
                limit: 10,
                format: 'json'
            }).done(function(res) {
                let schemaIds = [];
                let rawDescs = {};
                if (res && res[1] && res[1].length > 0) {
                    let titles = res[1];
                    let descriptions = res[2] || [];
                    for (let i = 0; i < titles.length; i++) {
                        let title = titles[i];
                        let match = title.match(/(E\d+)$/i);
                        let schemaId = match ? match[1].toUpperCase() : title.replace(/^EntitySchema:/i, '').trim();
                        schemaIds.push(schemaId);
                        rawDescs[schemaId] = descriptions[i] || '';
                    }
                    fetchLabelsForSchemas(schemaIds, rawDescs).then(resolve);
                } else {
                    // Fallback to fulltext search in namespace 640
                    api.get({
                        action: 'query',
                        list: 'search',
                        srnamespace: 640,
                        srsearch: term,
                        srlimit: 10,
                        format: 'json'
                    }).done(function(searchRes) {
                        let searchList = (searchRes && searchRes.query && searchRes.query.search) || [];
                        let listIds = [];
                        let listDescs = {};
                        searchList.forEach(item => {
                            let match = item.title.match(/(E\d+)$/i);
                            let schemaId = match ? match[1].toUpperCase() : item.title.replace(/^EntitySchema:/i, '').trim();
                            let snippetClean = item.snippet ? item.snippet.replace(/<[^>]+>/g, '') : '';
                            listIds.push(schemaId);
                            listDescs[schemaId] = snippetClean;
                        });
                        fetchLabelsForSchemas(listIds, listDescs).then(resolve);
                    }).fail(function(err) {
                        logError("[Cradle] Fulltext search fallback failed:", err);
                        resolve([]);
                    });
                }
            }).fail(function(err) {
                logError("[Cradle] EntitySchema opensearch request failed:", err);
                resolve([]);
            });
        });
    }

    /**
     * Attaches autocompletion dropdown for EntitySchema search inputs.
     */
    function attachEntitySchemaAutocompleter($wrapper, $input, onLoadCallback) {
        $wrapper.css({'position': 'relative'});
        let $dropdown = $('<ul>').addClass('cradle-autocomplete-dropdown').hide();
        $wrapper.append($dropdown);

        let searchTimeout = null;

        $input.on('input', function() {
            let query = $(this).val().trim();
            if (searchTimeout) clearTimeout(searchTimeout);

            if (query.length < 2) {
                $dropdown.empty().hide();
                return;
            }

            searchTimeout = setTimeout(function() {
                searchEntitySchemas(query).then(results => {
                    $dropdown.empty();
                    if (results.length === 0) {
                        $dropdown.hide();
                        return;
                    }

                    results.forEach(res => {
                        let $row = $('<li>').addClass('cradle-autocomplete-row');
                        let labelText = (res.label && res.label !== res.id) ? `${res.label} (${res.id})` : res.id;
                        $row.append($('<span>').addClass('cradle-autocomplete-row-label').text(labelText));
                        if (res.description) {
                            $row.append($('<span>').addClass('cradle-autocomplete-row-desc').text(res.description));
                        }

                        $row.on('click', function(e) {
                            e.stopPropagation();
                            $input.val(`${res.id}`);
                            $dropdown.hide();
                            if (typeof onLoadCallback === 'function') {
                                onLoadCallback(res.id);
                            }
                        });

                        $dropdown.append($row);
                    });
                    $dropdown.show();
                });
            }, 300);
        });

        $(document).on('click.cradleSchemaAutocomplete', function(e) {
            if (!$wrapper.is(e.target) && $wrapper.has(e.target).length === 0) {
                $dropdown.hide();
            }
        });
    }

    let cachedLanguageList = null;
    let commonLanguageNames = {
        'en': 'English inglés',
        'es': 'Spanish español',
        'fr': 'French francés',
        'de': 'German alemán',
        'it': 'Italian italiano',
        'pt': 'Portuguese portugués',
        'pt-br': 'Brazilian Portuguese portugués brasileño',
        'ru': 'Russian ruso',
        'zh': 'Chinese chino',
        'zh-hans': 'Simplified Chinese chino simplificado',
        'zh-hant': 'Traditional Chinese chino tradicional',
        'ja': 'Japanese japonés',
        'ko': 'Korean coreano',
        'ar': 'Arabic árabe',
        'hi': 'Hindi hindi',
        'bn': 'Bengali bengalí',
        'nl': 'Dutch holandés neerlandés',
        'sv': 'Swedish sueco',
        'pl': 'Polish polaco',
        'uk': 'Ukrainian ucraniano',
        'tr': 'Turkish turco',
        'vi': 'Vietnamese vietnamita',
        'ca': 'Catalan catalán',
        'gl': 'Galician gallego',
        'eu': 'Basque euskera vasco',
        'ast': 'Asturian asturiano',
        'qu': 'Quechua quechua',
        'ay': 'Aymara aimara',
        'gn': 'Guarani guaraní',
        'eo': 'Esperanto esperanto',
        'la': 'Latin latín',
        'grc': 'Ancient Greek griego antiguo',
        'el': 'Greek griego',
        'he': 'Hebrew hebreo',
        'fa': 'Persian persa',
        'th': 'Thai tailandés',
        'id': 'Indonesian indonesio',
        'ms': 'Malay malayo',
        'sw': 'Swahili suajili',
        'fi': 'Finnish finlandés',
        'da': 'Danish danés',
        'no': 'Norwegian noruego',
        'nb': 'Bokmål noruego bokmål',
        'nn': 'Nynorsk noruego nynorsk',
        'cs': 'Czech checo',
        'hu': 'Hungarian húngaro',
        'ro': 'Romanian rumano',
        'bg': 'Bulgarian búlgaro',
        'sr': 'Serbian serbio',
        'hr': 'Croatian croata',
        'sk': 'Slovak eslovaco',
        'sl': 'Slovenian esloveno',
        'et': 'Estonian estonio',
        'lv': 'Latvian letón',
        'lt': 'Lithuanian lituano'
    };

    function fetchSupportedLanguages() {
        if (cachedLanguageList) {
            return Promise.resolve(cachedLanguageList);
        }
        return new Promise((resolve) => {
            let api = new mw.Api();
            api.get({
                action: 'query',
                meta: 'wbcontentlanguages|languageinfo',
                wbclcontext: 'monolingualtext',
                wbclprop: 'code|name|autonym',
                liprop: 'code|name|autonym',
                formatversion: 2
            }).done(function(res) {
                let wbLangs = (res && res.query && res.query.wbcontentlanguages) ? res.query.wbcontentlanguages : {};
                let cldrLangs = (res && res.query && res.query.languageinfo) ? res.query.languageinfo : {};
                
                let codes = new Set([...Object.keys(wbLangs), ...Object.keys(cldrLangs)]);
                if (codes.size > 0) {
                    cachedLanguageList = Array.from(codes).map(code => {
                        let wbObj = wbLangs[code] || {};
                        let cldrObj = cldrLangs[code] || {};
                        let autonym = cldrObj.autonym || wbObj.autonym || wbObj.name || code;
                        let name = cldrObj.name || wbObj.name || autonym;
                        let extra = commonLanguageNames[code] || '';
                        
                        let displayName = name || autonym;
                        return {
                            code: code,
                            name: displayName,
                            searchStr: (code + ' ' + name + ' ' + autonym + ' ' + extra).toLowerCase()
                        };
                    });
                    
                    cachedLanguageList.sort((a, b) => a.code.localeCompare(b.code));
                    resolve(cachedLanguageList);
                    return;
                }
                fallbackLangs();
            }).fail(function() {
                fallbackLangs();
            });

            function fallbackLangs() {
                api.get({
                    action: 'query',
                    meta: 'siteinfo',
                    siprop: 'languages',
                    formatversion: 2
                }).done(function(res) {
                    let langs = (res && res.query && res.query.languages) ? res.query.languages : [];
                    cachedLanguageList = langs.map(l => {
                        let code = l.code || '';
                        let autonym = l.name || l['*'] || code;
                        let extra = commonLanguageNames[code] || '';
                        return {
                            code: code,
                            name: autonym,
                            searchStr: (code + ' ' + autonym + ' ' + extra).toLowerCase()
                        };
                    });
                    resolve(cachedLanguageList);
                }).fail(function() {
                    cachedLanguageList = Object.keys(commonLanguageNames).map(c => ({
                        code: c,
                        name: commonLanguageNames[c].split(' ')[0],
                        searchStr: (c + ' ' + commonLanguageNames[c]).toLowerCase()
                    }));
                    resolve(cachedLanguageList);
                });
            }
        });
    }

    function setupLanguageAutocomplete($input, onSelect) {
        let $wrapper = $('<div>').addClass('cradle-lang-autocomplete-wrapper').css({
            'position': 'relative',
            'flex': '0 0 110px',
            'min-width': '110px',
            'display': 'inline-block'
        });
        $input.css({'width': '100%', 'box-sizing': 'border-box'}).wrap($wrapper);
        let $containerWrapper = $input.parent();

        let $dropdown = $('<ul>').addClass('cradle-autocomplete-dropdown').css({
            'position': 'absolute',
            'top': '100%',
            'left': '0',
            'min-width': '220px',
            'max-height': '180px',
            'overflow-y': 'auto',
            'z-index': '10010',
            'background-color': 'var(--background-color-base, #ffffff)',
            'border': '1px solid var(--border-color-base, #a2a9b1)',
            'border-radius': '2px',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.15)',
            'margin': '2px 0 0 0',
            'padding': '0',
            'list-style': 'none'
        }).hide();
        $containerWrapper.append($dropdown);

        function updateDropdown() {
            let q = $input.val().trim().toLowerCase();
            fetchSupportedLanguages().then(langs => {
                let filtered = [];
                if (!q) {
                    filtered = langs.slice(0, 12);
                } else {
                    filtered = langs.filter(l => l.searchStr.includes(q));
                    filtered.sort((a, b) => {
                        if (a.code === q) return -1;
                        if (b.code === q) return 1;
                        if (a.code.startsWith(q)) return -1;
                        if (b.code.startsWith(q)) return 1;
                        return 0;
                    });
                    filtered = filtered.slice(0, 15);
                }

                $dropdown.empty();
                if (filtered.length === 0) {
                    $dropdown.hide();
                    return;
                }

                filtered.forEach(item => {
                    let $li = $('<li>').addClass('cradle-autocomplete-row').css({
                        'padding': '6px 10px',
                        'font-size': '0.8rem',
                        'cursor': 'pointer',
                        'display': 'flex',
                        'justify-content': 'space-between',
                        'align-items': 'center'
                    });
                    $li.append($('<span>').css({'font-weight': 'bold'}).text(item.name));
                    $li.append($('<small>').css({'color': 'var(--color-subtle, #54595d)', 'margin-left': '6px'}).text(`(${item.code})`));

                    $li.on('click mousedown', function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        $input.val(item.code);
                        $dropdown.hide();
                        if (typeof onSelect === 'function') {
                            onSelect(item.code);
                        }
                    });
                    $dropdown.append($li);
                });
                $dropdown.show();
            });
        }

        $input.on('focus input', function() {
            updateDropdown();
        });

        $(document).on('click.cradleLangAutocomplete', function(e) {
            if (!$wrapper.is(e.target) && $wrapper.has(e.target).length === 0) {
                $dropdown.hide();
            }
        });
    }

function searchWikidataItems(term) {
        logDebug("[Cradle] Searching Wikidata items for:", term);
        return new Promise((resolve) => {
            let api = new mw.Api();
            api.get({
                action: 'wbsearchentities',
                search: term,
                language: mw.config.get('wgUserLanguage') || 'en',
                type: 'item',
                format: 'json'
            }).done(function(res) {
                logDebug("[Cradle] Search results received:", res.search);
                resolve(res.search || []);
            }).fail(function(err) {
                logError("[Cradle] Search API request failed:", err);
                resolve([]);
            });
        });
    }

    /**
     * Saves form changes back to Wikidata (either editing an item or creating a new one).
     */
    function saveForm() {
        let claimsPayload = {};
        let hasChanges = false;
        let mandatoryErrors = [];

        let creationData = {
            labels: {},
            descriptions: {},
            aliases: {},
            claims: claimsPayload
        };

        if (activeMode === 'create') {
            let primaryLabelFound = false;

            $('.cradle-identity-lang-row').each(function() {
                let langCode = $(this).find('.cradle-lang-input').val().trim() || 'en';
                let labelVal = $(this).find('.cradle-label-input').val().trim();
                let descVal = $(this).find('.cradle-desc-input').val().trim();
                let aliasesVal = $(this).find('.cradle-aliases-input').val().trim();

                if (labelVal) {
                    creationData.labels[langCode] = { language: langCode, value: labelVal };
                    primaryLabelFound = true;
                }
                if (descVal) {
                    creationData.descriptions[langCode] = { language: langCode, value: descVal };
                }
                if (aliasesVal) {
                    let aliasList = aliasesVal.split('|').map(a => a.trim()).filter(Boolean);
                    if (aliasList.length > 0) {
                        creationData.aliases[langCode] = aliasList.map(a => ({ language: langCode, value: a }));
                    }
                }
            });

            if (!primaryLabelFound) {
                mandatoryErrors.push(mw.msg('cradle-label-required'));
            }
        }

        // Validate mandatory claims & Wikidata constraints
        Object.keys(schemaProperties).forEach(pid => {
            let propDef = schemaProperties[pid];
            let rows = formState[pid];
            let meta = propertyMetadata[pid] || { label: pid };
            
            let activeClaimsCount = rows.filter(r => !r.isDeleted && !isEmptyValue(r.value, r.datatype)).length;
            
            if (propDef.mandatory && activeClaimsCount === 0) {
                mandatoryErrors.push(mw.msg('cradle-mandatory-error', meta.label, pid));
            }

            // Also check Wikidata mandatory constraint (P2302 -> Q21503250)
            if (meta.constraints && meta.constraints.length > 0) {
                meta.constraints.forEach(c => {
                    if (c.isMandatory && activeClaimsCount === 0 && !propDef.mandatory) {
                        mandatoryErrors.push(mw.msg('cradle-constraint-mandatory-alert', meta.label, pid));
                    }
                });
            }
        });

        // Build claims payload
        Object.keys(formState).forEach(pid => {
            let rows = formState[pid];
            let original = (activeMode === 'edit' && entityData.claims && entityData.claims[pid]) || [];
            let propertyClaims = [];

            rows.forEach(row => {
                if (row.isDeleted) {
                    if (row.guid) {
                        propertyClaims.push({
                            id: row.guid,
                            remove: ""
                        });
                        hasChanges = true;
                    }
                    return;
                }

                if (isEmptyValue(row.value, row.datatype)) return;

                let datavalue = constructDataValue(row.value, row.datatype);
                if (!datavalue) return;

                if (row.guid) {
                    // Update claim
                    let origClaim = original.find(c => c.id === row.guid);
                    if (origClaim && isValueChanged(origClaim, datavalue)) {
                        propertyClaims.push({
                            id: row.guid,
                            mainsnak: {
                                snaktype: 'value',
                                property: pid,
                                datavalue: datavalue
                            },
                            type: 'statement'
                        });
                        hasChanges = true;
                    }
                } else {
                    // Add new claim
                    propertyClaims.push({
                        mainsnak: {
                            snaktype: 'value',
                            property: pid,
                            datavalue: datavalue
                        },
                        type: 'statement'
                    });
                    hasChanges = true;
                }
            });

            if (propertyClaims.length > 0) {
                claimsPayload[pid] = propertyClaims;
            }
        });

        if (activeMode === 'edit' && !hasChanges) {
            mw.notify(mw.msg('cradle-no-changes'), { type: 'warn' });
            closeEditor();
            return;
        }

        // Disable Save button and show spinner
        let $saveBtn = $('.cradle-btn-primary').prop('disabled', true);
        let origHtml = $saveBtn.html();
        $saveBtn.html($('<div>').addClass('cradle-spinner'));

        let api = new mw.Api();
        let queryParams = {
            action: 'wbeditentity'
        };

        if (activeMode === 'edit') {
            queryParams.id = entityId;
            queryParams.data = JSON.stringify({ claims: claimsPayload });
            queryParams.summary = mw.msg('cradle-edit-summary', activeSchema ? activeSchema.id : 'Custom');
        } else {
            queryParams.new = 'item';
            queryParams.data = JSON.stringify(creationData);
            queryParams.summary = mw.msg('cradle-create-summary', activeTemplate ? activeTemplate.title : (activeSchema ? activeSchema.id : 'Custom'));
        }

        api.postWithEditToken(queryParams).then(res => {
            if (activeMode === 'edit') {
                mw.notify(mw.msg('cradle-save-success'), { type: 'success' });
                setTimeout(() => {
                    location.reload();
                }, 1000);
            } else {
                let newQid = res.entity.id;
                mw.notify(mw.msg('cradle-create-success', newQid), { type: 'success' });
                setTimeout(() => {
                    location.href = mw.util.getUrl(newQid);
                }, 1200);
            }
        }).catch((code, err) => {
            logError("[Cradle] Save error:", code, err);
            let errMsg = err && err.error && err.error.info ? err.error.info : code;
            mw.notify(mw.msg('cradle-save-error', errMsg), { type: 'error' });
            $saveBtn.prop('disabled', false).html(origHtml);
        });
    }

    /**
     * Checks if value is empty depending on data type.
     */
    function isEmptyValue(value, datatype) {
        if (value === null || value === undefined) return true;
        if (datatype === 'monolingualtext') {
            return !value.text || !value.language;
        }
        if (typeof value === 'string') {
            return value.trim() === '';
        }
        return false;
    }

    /**
     * Constructs the standard Wikibase API datavalue object.
     */
    function constructDataValue(value, datatype) {
        if (datatype === 'wikibase-item') {
            let qid = typeof value === 'string' ? value.trim().toUpperCase() : value.id;
            if (!qid.startsWith('Q')) return null;
            let numId = parseInt(qid.substring(1));
            return {
                type: 'wikibase-entityid',
                value: {
                    'entity-type': 'item',
                    'numeric-id': numId,
                    'id': qid
                }
            };
        }
        if (datatype === 'string' || datatype === 'external-id' || datatype === 'url' || datatype === 'commonsMedia') {
            return {
                type: 'string',
                value: value.trim()
            };
        }
        if (datatype === 'monolingualtext') {
            return {
                type: 'monolingualtext',
                value: {
                    text: value.text.trim(),
                    language: value.language.trim().toLowerCase()
                }
            };
        }
        if (datatype === 'quantity') {
            let valStr = String(value).trim();
            if (valStr && !valStr.startsWith('+') && !valStr.startsWith('-')) {
                valStr = '+' + valStr;
            }
            return {
                type: 'quantity',
                value: {
                    amount: valStr,
                    unit: '1'
                }
            };
        }
        if (datatype === 'time') {
            return parseNaturalDate(value);
        }
        return null;
    }

    /**
     * Checks if form input value differs from existing claim value.
     */
    function isValueChanged(origClaim, datavalue) {
        if (!origClaim.mainsnak || !origClaim.mainsnak.datavalue) return true;
        let origVal = origClaim.mainsnak.datavalue.value;
        let newVal = datavalue.value;
        
        if (datavalue.type !== origClaim.mainsnak.datavalue.type) return true;
        
        if (datavalue.type === 'wikibase-entityid') {
            return origVal.id !== newVal.id;
        }
        if (datavalue.type === 'string') {
            return origVal !== newVal;
        }
        if (datavalue.type === 'monolingualtext') {
            return origVal.text !== newVal.text || origVal.language !== newVal.language;
        }
        if (datavalue.type === 'quantity') {
            return parseFloat(origVal.amount) !== parseFloat(newVal.amount);
        }
        if (datavalue.type === 'time') {
            return origVal.time !== newVal.time;
        }
        return JSON.stringify(origVal) !== JSON.stringify(newVal);
    }

    // Load hook
    
    /**
     * Reconstruct user schemas from a single User:Name/Cradle page wikitext.
     */
    function parseUserCradlePage(wikitext) {
        let sections = {};
        if (!wikitext) return sections;
        let lines = wikitext.split('\n');
        let currentHeader = null;
        let currentLines = [];
        
        lines.forEach(line => {
            let headerMatch = line.match(/^==\s*(.+?)\s*==$/);
            if (headerMatch) {
                if (currentHeader) {
                    sections[currentHeader] = currentLines.join('\n');
                }
                currentHeader = headerMatch[1].trim();
                currentLines = [line];
            } else {
                if (currentHeader) {
                    currentLines.push(line);
                }
            }
        });
        if (currentHeader) {
            sections[currentHeader] = currentLines.join('\n');
        }
        return sections;
    }

    /**
     * Fetch the wikitext sections of User:Name/Cradle page.
     */
    function fetchUserSchemas(callback) {
        let api = new mw.Api();
        let userName = mw.config.get('wgUserName');
        if (!userName) {
            if (callback) callback({});
            return;
        }
        let pageTitle = 'User:' + userName + '/Cradle';
        api.get({
            action: 'query',
            prop: 'revisions',
            titles: pageTitle,
            rvprop: 'content',
            rvslots: 'main',
            formatversion: 2
        }).done(function(data) {
            let page = data.query.pages[0];
            if (page && !page.missing) {
                let content = page.revisions[0].slots.main.content;
                let sections = parseUserCradlePage(content);
                if (callback) callback(sections);
            } else {
                if (callback) callback({});
            }
        }).fail(function() {
            if (callback) callback({});
        });
    }

    /**
     * Delete a schema section from User:Name/Cradle page.
     */
    function deleteSchemaFromPage(schemaName) {
        let api = new mw.Api();
        let userName = mw.config.get('wgUserName');
        let pageTitle = 'User:' + userName + '/Cradle';
        api.get({
            action: 'query',
            prop: 'revisions',
            titles: pageTitle,
            rvprop: 'content',
            rvslots: 'main',
            formatversion: 2
        }).done(function(data) {
            let page = data.query.pages[0];
            if (!page || page.missing) return;
            let content = page.revisions[0].slots.main.content;
            let sections = parseUserCradlePage(content);
            if (sections[schemaName]) {
                delete sections[schemaName];
                let newWikitext = Object.values(sections).join('\n\n');
                api.postWithToken('csrf', {
                    action: 'edit',
                    title: pageTitle,
                    text: newWikitext,
                    summary: 'Eliminado esquema de Cradle: ' + schemaName,
                    formatversion: 2
                }).done(function() {
                    mw.notify(mw.msg('cradle-schema-deleted'));
                    renderCreateOptionsSelector();
                });
            }
        });
    }

    /**
     * Add or update a schema section on User:Name/Cradle page.
     */
    function saveOrUpdateSchema(schemaName, schemaWikitext, callback) {
        let api = new mw.Api();
        let userName = mw.config.get('wgUserName');
        let pageTitle = 'User:' + userName + '/Cradle';
        api.get({
            action: 'query',
            prop: 'revisions',
            titles: pageTitle,
            rvprop: 'content',
            rvslots: 'main',
            formatversion: 2
        }).done(function(data) {
            let page = data.query.pages[0];
            let content = "";
            if (page && !page.missing) {
                content = page.revisions[0].slots.main.content;
            }
            let sections = parseUserCradlePage(content);
            sections[schemaName] = schemaWikitext;
            let newWikitext = Object.values(sections).join('\n\n');
            api.postWithToken('csrf', {
                action: 'edit',
                title: pageTitle,
                text: newWikitext,
                summary: 'Creado/Actualizado esquema de Cradle: ' + schemaName,
                formatversion: 2
            }).done(function() {
                mw.notify(mw.msg('cradle-schema-saved'));
                if (callback) callback();
            }).fail(function(code, err) {
                mw.notify('Error al guardar el esquema: ' + code, { type: 'error' });
            });
        });
    }

    /**
     * Search community user schemas having "/Cradle" in user space.
     */
    function searchCommunitySchemas(searchQuery, callback) {
        let api = new mw.Api();
        api.get({
            action: 'query',
            list: 'search',
            srnamespace: 2,
            srsearch: 'intitle:"/Cradle" ' + searchQuery,
            format: 'json'
        }).done(function(data) {
            if (!data.query || !data.query.search) {
                callback([]);
                return;
            }
            let pending = data.query.search.length;
            let results = [];
            if (pending === 0) {
                callback([]);
                return;
            }
            data.query.search.forEach(page => {
                api.get({
                    action: 'query',
                    prop: 'revisions',
                    titles: page.title,
                    rvprop: 'content',
                    rvslots: 'main',
                    formatversion: 2
                }).done(function(pageData) {
                    let p = pageData.query.pages[0];
                    if (p && !p.missing) {
                        let content = p.revisions[0].slots.main.content;
                        let sections = parseUserCradlePage(content);
                        let author = page.title.split('/Cradle')[0].replace('User:', '');
                        Object.keys(sections).forEach(schemaName => {
                            if (schemaName.toLowerCase().includes(searchQuery.toLowerCase()) || searchQuery === '') {
                                results.push({
                                    title: page.title,
                                    name: schemaName,
                                    author: author
                                });
                            }
                        });
                    }
                    pending--;
                    if (pending === 0) {
                        callback(results);
                    }
                }).fail(function() {
                    pending--;
                    if (pending === 0) {
                        callback(results);
                    }
                });
            });
        }).fail(function() {
            callback([]);
        });
    }

    /**
     * Loads a user schema, parses it, and loads the active template.
     */
    function loadAndDisplayUserSchema(fullTitle, schemaName) {
        let api = new mw.Api();
        api.get({
            action: 'query',
            prop: 'revisions',
            titles: fullTitle,
            rvprop: 'content',
            rvslots: 'main',
            formatversion: 2
        }).done(function(data) {
            let page = data.query.pages[0];
            if (page && !page.missing) {
                let content = page.revisions[0].slots.main.content;
                let sections = parseUserCradlePage(content);
                if (sections[schemaName]) {
                    let parsed = parseCradleWikitext(sections[schemaName]);
                    cradleTemplates[schemaName.toLowerCase().replace(/ /g, '_')] = {
                        title: schemaName,
                        labels: parsed.labels,
                        props: parsed.props
                    };
                    loadAndDisplayTemplate(schemaName.toLowerCase().replace(/ /g, '_'));
                } else {
                    mw.notify(mw.msg('cradle-schema-not-found'), { type: 'error' });
                }
            }
        });
    }

    /**
     * Generates rich Wikidata-standard ShEx (Shape Expression) code for an EntitySchema.
     */
    function generateShExCode(title, propRows, propertyLabels, targetItem) {
        let cleanTitle = (title || 'custom_shape').toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!cleanTitle) cleanTitle = 'custom_shape';
        let targetQID = (targetItem || '').trim().toUpperCase();

        let lines = [];
        if (targetQID && /^Q\d+$/i.test(targetQID)) {
            lines.push(`# targetItem: ${targetQID}`);
            lines.push(`# Associated Item / Target Class: ${targetQID}`);
        }
        lines.push(`# Schema: ${title || cleanTitle}`);
        lines.push(`# Generated with Cradle Schema Designer`);
        lines.push(``);
        lines.push(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>`);
        lines.push(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>`);
        lines.push(`PREFIX wd: <http://www.wikidata.org/entity/>`);
        lines.push(`PREFIX wdt: <http://www.wikidata.org/prop/direct/>`);
        lines.push(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`);
        lines.push(``);
        lines.push(`start = @<${cleanTitle}>`);
        lines.push(``);
        lines.push(`<${cleanTitle}> EXTRA wdt:P31 {`);

        let propMap = propertyLabels || propertyMetadata || {};

        propRows.forEach((row) => {
            let pid = row.pid;
            let meta = propMap[pid] || {};
            let label = meta.label || pid;

            let options = [];
            let qidsStr = row.hardselect || row.softselect || '';
            if (qidsStr) {
                let qids = qidsStr.split(',').map(q => q.trim()).filter(q => /^Q\d+$/i.test(q));
                if (qids.length > 0) {
                    options = qids.map(q => `wd:${q.toUpperCase()}`);
                }
            }

            let valueExpr = options.length > 0 ? `[${options.join(' ')}]` : '.';
            
            let cardSymbol = ';';
            if (row.cardinality === '+') cardSymbol = '+ ;';
            else if (row.cardinality === '*') cardSymbol = '* ;';
            else if (row.cardinality === '?') cardSymbol = '? ;';
            else if (row.cardinality === '1') cardSymbol = ';';
            else if (row.mandatory) cardSymbol = row.allowMultiple ? '+ ;' : ';';
            else cardSymbol = row.allowMultiple ? '* ;' : '? ;';

            let comment = label ? `   # ${label}` : '';
            lines.push(`  wdt:${pid} ${valueExpr} ${cardSymbol}${comment}`);
        });

        lines.push(`  rdfs:label rdf:langString+;`);
        lines.push(`}`);
        return lines.join('\n');
    }

    /**
     * Validates ShEx (Shape Expression) syntax and returns { valid: boolean, errors: Array<string> }.
     */
    function validateShExSyntax(shexText) {
        let errors = [];
        if (!shexText || !shexText.trim()) {
            return { valid: false, errors: ['ShEx code is empty.'] };
        }

        let lines = shexText.split('\n');
        
        // 1. Check balanced brackets, braces, and angle brackets
        let openBraces = (shexText.match(/\{/g) || []).length;
        let closeBraces = (shexText.match(/\}/g) || []).length;
        if (openBraces !== closeBraces) {
            errors.push(`Unbalanced braces: found ${openBraces} '{' and ${closeBraces} '}'.`);
        }

        let openBrackets = (shexText.match(/\[/g) || []).length;
        let closeBrackets = (shexText.match(/\]/g) || []).length;
        if (openBrackets !== closeBrackets) {
            errors.push(`Unbalanced brackets: found ${openBrackets} '[' and ${closeBrackets} ']'.`);
        }

        let openAngles = (shexText.match(/</g) || []).length;
        let closeAngles = (shexText.match(/>/g) || []).length;
        if (openAngles !== closeAngles) {
            errors.push(`Unbalanced angle brackets: found ${openAngles} '<' and ${closeAngles} '>'.`);
        }

        // 2. Check start shape declaration vs shape definition
        let startMatch = shexText.match(/start\s*=\s*@<\s*(.+?)\s*>/i);
        if (startMatch) {
            let startShapeName = startMatch[1];
            let shapeDefRegex = new RegExp(`<\\s*${startShapeName}\\s*>`, 'i');
            if (!shapeDefRegex.test(shexText)) {
                errors.push(`Declaration 'start = @<${startShapeName}>' does not match any defined shape '<${startShapeName}> {'.`);
            }
        } else if (!/<[^>]+>\s*(?:EXTRA\s+[^{]+)?\s*\{/.test(shexText)) {
            errors.push("No valid shape definition found like '<ShapeName> { ... }'.");
        }

        // 3. Line-by-line checks for property syntax
        let inShape = false;
        lines.forEach((line, idx) => {
            let cleanLine = line.replace(/#.*/, '').trim();
            if (!cleanLine) return;

            if (cleanLine.includes('{')) inShape = true;
            if (cleanLine.includes('}')) inShape = false;

            if (inShape && !cleanLine.startsWith('{') && !cleanLine.startsWith('}')) {
                if (cleanLine.includes(':')) {
                    let propMatch = cleanLine.match(/(?:wdt|p|ps|pxt):([A-Za-z0-9_]+)/);
                    if (propMatch) {
                        let pid = propMatch[1];
                        if (!/^P\d+$/i.test(pid)) {
                            errors.push(`Line ${idx + 1}: Invalid property ID '${pid}' (must be format P123).`);
                        }
                    }
                    let bracketMatch = cleanLine.match(/\[\s*([^\]]+)\s*\]/);
                    if (bracketMatch) {
                        let items = bracketMatch[1].split(/\s+/).filter(Boolean);
                        items.forEach(item => {
                            if (item.startsWith('wd:')) {
                                let qid = item.substring(3);
                                if (!/^Q\d+$/i.test(qid)) {
                                    errors.push(`Line ${idx + 1}: Invalid QID '${item}' (must be format wd:Q123).`);
                                }
                            }
                        });
                    }
                }
            }
        });

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Publishes a new EntitySchema to Wikidata via the wbeditentityschema MediaWiki API.
     */
    function publishEntitySchemaToWikidata(title, desc, aliasesStr, shexText) {
        let userLang = mw.config.get('wgUserLanguage') || 'en';
        let cleanTitle = (title || 'Custom Schema').trim();

        let api = new mw.Api();
        let payload = {
            labels: {
                [userLang]: { language: userLang, value: cleanTitle }
            },
            schemaText: shexText
        };

        if (desc && desc.trim()) {
            payload.descriptions = {
                [userLang]: { language: userLang, value: desc.trim() }
            };
        }

        if (aliasesStr && aliasesStr.trim()) {
            let aliasList = aliasesStr.split('|').map(a => a.trim()).filter(Boolean);
            if (aliasList.length > 0) {
                payload.aliases = {
                    [userLang]: aliasList.map(a => ({ language: userLang, value: a }))
                };
            }
        }

        return api.postWithEditToken({
            action: 'wbeditentityschema',
            new: 'entityschema',
            data: JSON.stringify(payload),
            summary: 'Created EntitySchema using Cradle Wikidata Gadget'
        }).then(function(res) {
            if (res && res.entityschema && res.entityschema.id) {
                return res.entityschema.id;
            } else if (res && res.entity && res.entity.id) {
                return res.entity.id;
            }
            throw new Error(res.error ? res.error.info : 'Unknown API response');
        });
    }

    /**
     * Displays a modal overlay to preview ShEx code, copy it, or publish on Wikidata via MediaWiki API.
     */
    function openShExExportModal(title, propRows, labelsMap, targetItem) {
        let shexText = generateShExCode(title, propRows, labelsMap, targetItem);

        let $overlay = $('<div>').addClass('cradle-modal-overlay').css({
            'position': 'fixed',
            'top': '0',
            'left': '0',
            'right': '0',
            'bottom': '0',
            'background': 'rgba(0,0,0,0.5)',
            'z-index': '10000',
            'display': 'flex',
            'align-items': 'center',
            'justify-content': 'center'
        });

        let $modal = $('<div>').css({
            'background': '#fff',
            'border-radius': '6px',
            'padding': '20px',
            'max-width': '550px',
            'width': '90%',
            'box-shadow': '0 4px 16px rgba(0,0,0,0.3)',
            'display': 'flex',
            'flex-direction': 'column',
            'gap': '12px'
        });

        $modal.append($('<h3>').css({'margin':'0'}).text(mw.msg('cradle-shex-preview')));

        let $statusBox = $('<div>').css({
            'padding': '8px 12px',
            'border-radius': '4px',
            'font-size': '12px',
            'font-weight': 'bold'
        });
        $modal.append($statusBox);

        let $textarea = $('<textarea>')
            .css({
                'width': '100%',
                'height': '200px',
                'font-family': 'monospace',
                'font-size': '12px',
                'padding': '8px',
                'border': '1px solid #a2a9b1',
                'border-radius': '4px',
                'box-sizing': 'border-box'
            })
            .val(shexText);

        $modal.append($textarea);

        let $btnRow = $('<div>').css({'display': 'flex', 'gap': '8px', 'justify-content': 'flex-end', 'flex-wrap': 'wrap'});

        let $copyBtn = $('<button>').addClass('cdx-button')
            .text(mw.msg('cradle-copy-shex'))
            .on('click', function() {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText($textarea.val()).then(function() {
                        mw.notify('ShEx copied to clipboard!', { type: 'info' });
                    });
                } else {
                    $textarea.select();
                    document.execCommand('copy');
                    mw.notify('ShEx copied to clipboard!', { type: 'info' });
                }
            });

        let $publishBtn = $('<button>').addClass('cdx-button cdx-button--action-progressive cdx-button--weight-primary')
            .text(mw.msg('cradle-create-entityschema-btn'))
            .on('click', function() {
                let code = $textarea.val();
                let res = validateShExSyntax(code);
                if (!res.valid) {
                    mw.notify('Please fix ShEx syntax errors before publishing.', { type: 'error' });
                    return;
                }

                $publishBtn.prop('disabled', true).text(mw.msg('cradle-publishing-shex'));

                let schemaDesc = $('#cradle-schema-desc-input').length ? $('#cradle-schema-desc-input').val().trim() : '';
                let schemaAliases = $('#cradle-schema-aliases-input').length ? $('#cradle-schema-aliases-input').val().trim() : '';

                publishEntitySchemaToWikidata(title, schemaDesc, schemaAliases, code).then(function(newId) {
                    mw.notify(mw.msg('cradle-publish-shex-success', newId), { type: 'success' });
                    setTimeout(function() {
                        window.location.href = mw.util.getUrl('EntitySchema:' + newId);
                    }, 1200);
                }).catch(function(err) {
                    console.warn('[Cradle] wbeditentityschema API failed, opening Special:NewEntitySchema:', err);
                    mw.notify('Opening Special:NewEntitySchema...', { type: 'warn' });
                    window.open(mw.util.getUrl('Special:NewEntitySchema'), '_blank');
                    $publishBtn.prop('disabled', false).text(mw.msg('cradle-create-entityschema-btn'));
                });
            });

        function updateValidationUI() {
            let res = validateShExSyntax($textarea.val());
            if (res.valid) {
                $statusBox.css({
                    'background': '#e6f9f0',
                    'border': '1px solid #00af89',
                    'color': '#00805d'
                }).html(mw.msg('cradle-shex-valid'));
                $publishBtn.prop('disabled', false);
            } else {
                let $errHtml = $('<div>').append($('<div>').text(mw.msg('cradle-shex-invalid')));
                let $ul = $('<ul>').css({'margin': '4px 0 0 16px', 'padding': '0', 'font-weight': 'normal'});
                res.errors.forEach(e => $ul.append($('<li>').text(e)));
                $errHtml.append($ul);
                $statusBox.css({
                    'background': '#fef2f2',
                    'border': '1px solid #d33',
                    'color': '#d33'
                }).html($errHtml);
                $publishBtn.prop('disabled', true);
            }
        }

        $textarea.on('input', updateValidationUI);
        updateValidationUI();

        let $closeBtn = $('<button>').addClass('cdx-button cdx-button--weight-quiet')
            .text(mw.msg('cradle-cancel'))
            .on('click', function() { $overlay.remove(); });

        $btnRow.append($copyBtn).append($publishBtn).append($closeBtn);
        $modal.append($btnRow);
        $overlay.append($modal);
        $('body').append($overlay);
    }

    /**
     * Displays a modal to import properties from an existing Wikidata Item (QID) and detect its P31 class.
     */
    function openPropertyImporterModal(fetchLabelsInBatches, onImportCallback) {
        let $overlay = $('<div>').addClass('cradle-modal-overlay').css({
            'position': 'fixed', 'top': '0', 'left': '0', 'right': '0', 'bottom': '0',
            'background': 'rgba(0,0,0,0.5)', 'z-index': '10000',
            'display': 'flex', 'align-items': 'center', 'justify-content': 'center'
        });

        let $modal = $('<div>').css({
            'background': '#fff', 'border-radius': '6px', 'padding': '20px',
            'max-width': '520px', 'width': '90%',
            'box-shadow': '0 4px 16px rgba(0,0,0,0.3)',
            'display': 'flex', 'flex-direction': 'column', 'gap': '12px'
        });

        let $headRow = $('<div>').css({'display': 'flex', 'justify-content': 'space-between', 'align-items': 'center'});
        $headRow.append($('<h3>').css({'margin': '0', 'display': 'inline-flex', 'align-items': 'center', 'gap': '6px'}).html(ICONS.download + ' <span>Importar propiedades desde un elemento</span>'));
        let $closeBtn = $('<button>').addClass('cradle-btn-secondary').html(ICONS.close).on('click', function() { $overlay.remove(); });
        $headRow.append($closeBtn);
        $modal.append($headRow);

        let $inputGroup = $('<div>').css({'display': 'flex', 'gap': '8px'});
        let $input = $('<input>').addClass('cradle-input').attr('placeholder', 'QID del elemento (ej: Q164027 Santiago Bernabéu o Q1203)').css({'flex': '1'});
        let $searchBtn = $('<button>').addClass('cdx-button cdx-button--action-progressive').text('Cargar elemento');
        $inputGroup.append($input).append($searchBtn);
        $modal.append($inputGroup);

        let $resultArea = $('<div>').css({'display': 'flex', 'flex-direction': 'column', 'gap': '10px', 'min-height': '60px'});
        $modal.append($resultArea);

        let fetchedPropPIDs = [];
        let p31Candidates = [];
        let selectedP31QID = '';

        $searchBtn.on('click', function() {
            let qid = $input.val().trim().toUpperCase();
            if (!qid || !/^Q\d+$/i.test(qid)) {
                mw.notify('Por favor ingrese un QID válido (ej: Q164027 o Q483110)', { type: 'error' });
                return;
            }
            $searchBtn.prop('disabled', true).text('Cargando...');
            $resultArea.empty().append($('<div>').css({'color': '#54595d', 'font-size': '13px'}).text('Consultando Wikidata y Recoin API...'));

            let api = new mw.Api();
            api.get({
                action: 'wbgetentities',
                ids: qid,
                props: 'claims|labels',
                languages: mw.config.get('wgUserLanguage') || 'en',
                format: 'json'
            }).done(function(res) {
                $searchBtn.prop('disabled', false).text('Cargar elemento');
                if (!res || !res.entities || !res.entities[qid] || !res.entities[qid].claims) {
                    $resultArea.html('<div style="color:#d33; font-size:13px;">No se encontraron propiedades en ' + qid + '</div>');
                    return;
                }
                let claims = res.entities[qid].claims;
                fetchedPropPIDs = sortPropertyIDs(Object.keys(claims));

                let p31QIDs = [];
                if (claims.P31) {
                    claims.P31.forEach(c => {
                        if (c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id) {
                            p31QIDs.push(c.mainsnak.datavalue.value.id);
                        }
                    });
                }

                let targetClassQID = p31QIDs.length > 0 ? p31QIDs[0] : qid;
                fetchRecoinData(targetClassQID, function(recoinData) {
                    let recoinFreqMap = {};
                    if (recoinData && recoinData.Frequenct_properties) {
                        recoinData.Frequenct_properties.forEach(m => {
                            let pid = m['Property ID'] || m.property;
                            let rawFreq = m.Frequency || m.frequency;
                            if (pid && rawFreq !== undefined) {
                                recoinFreqMap[pid] = parseFloat(rawFreq).toFixed(1) + '%';
                            }
                        });
                    }

                    let allQIDsToFetch = [...fetchedPropPIDs, ...p31QIDs];

                    fetchLabelsInBatches(allQIDsToFetch, function(labelsMap, datatypesMap) {
                        // Exclude external identifier properties (datatype: external-id)
                        fetchedPropPIDs = fetchedPropPIDs.filter(pid => datatypesMap[pid] !== 'external-id');

                        $resultArea.empty();
                        let ent = res.entities[qid];
                        let userLang = mw.config.get('wgUserLanguage') || 'en';
                        let itemLabel = (ent.labels && (ent.labels[userLang]?.value || ent.labels['en']?.value)) || labelsMap[qid] || qid;
                        p31Candidates = p31QIDs.map(id => ({ qid: id, label: labelsMap[id] || id }));

                        let $info = $('<div>').css({
                            'background': '#eaf3ff', 'border': '1px solid #36c',
                            'padding': '8px 12px', 'border-radius': '4px', 'font-size': '13px'
                        }).html(`<strong>${itemLabel} (${qid})</strong>: ${fetchedPropPIDs.length} propiedades encontradas en el elemento.`);
                        $resultArea.append($info);

                        // Fetch claims.P12861 (EntitySchema ID) for p31QIDs
                        let p31ClaimsMap = {};
                        let p31FetchDone = function() {
                            let $duplicateNoticeBox = $('<div>').css({'margin-top': '6px'});
                            let $importConfirmBtn = $('<button>').addClass('cdx-button cdx-button--action-progressive cdx-button--weight-primary')
                                .css({'display': 'inline-flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px', 'flex': '1', 'min-height': '38px', 'box-sizing': 'border-box'})
                                .html(ICONS.check + ` <span>Importar propiedades seleccionadas al diseñador</span>`);

                            let $editExistingSchemaBtn = $('<button>').addClass('cdx-button cdx-button--action-progressive')
                                .css({'display': 'none', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px', 'flex': '1', 'min-height': '38px', 'box-sizing': 'border-box'});

                            function updateSchemaExistenceCheck(chosenQID) {
                                let schemaId = p31ClaimsMap[chosenQID];
                                if (schemaId) {
                                    $duplicateNoticeBox.html(`
                                        <div style="background:#fcf2f2; border:1px solid #d33; color:#b32424; padding:8px 12px; border-radius:4px; font-size:12px;">
                                            ⚠️ <strong>Este esquema ya existe:</strong> La clase seleccionada <strong>${labelsMap[chosenQID] || chosenQID} (${chosenQID})</strong> ya tiene registrado el <strong><a href="/wiki/EntitySchema:${schemaId}" target="_blank" style="color:#b32424; text-decoration:underline;">EntitySchema ${schemaId}</a></strong> (declaración P12861).
                                        </div>
                                    `).show();
                                    $importConfirmBtn.prop('disabled', true).addClass('cdx-button--disabled');
                                    $editExistingSchemaBtn.html(ICONS.external + ` <span>Editar esquema ${schemaId} existente</span>`).off('click').on('click', function() {
                                        window.open('/wiki/EntitySchema:' + schemaId, '_blank');
                                    }).css('display', 'inline-flex');
                                    $btnRow.css({'justify-content': 'space-between'});
                                    $importConfirmBtn.css({'flex': '1'});
                                } else {
                                    $duplicateNoticeBox.empty().hide();
                                    $importConfirmBtn.prop('disabled', false).removeClass('cdx-button--disabled');
                                    $editExistingSchemaBtn.hide();
                                    $btnRow.css({'justify-content': 'center'});
                                    $importConfirmBtn.css({'flex': '0 1 auto'});
                                }
                            }

                            if (p31Candidates.length === 1) {
                                selectedP31QID = p31Candidates[0].qid;
                                let schemaId = p31ClaimsMap[selectedP31QID];
                                let badgeHtml = schemaId
                                    ? `<span style="background:#fcf2f2; color:#b32424; border:1px solid #d33; padding:1px 6px; border-radius:3px; font-size:11px; margin-left:6px;">⚠️ Ya existe: <strong>${schemaId}</strong></span>`
                                    : '';
                                $resultArea.append($('<div>').css({'font-size': '13px', 'color': '#202122'})
                                    .html(`Clase/Elemento asociado detectado (P31): <strong>${p31Candidates[0].label} (${selectedP31QID})</strong> ${badgeHtml}`));
                            } else if (p31Candidates.length > 1) {
                                let $p31Box = $('<div>').css({
                                    'display': 'flex', 'flex-direction': 'column', 'gap': '6px',
                                    'background': '#f8f9fa', 'border': '1px solid #c8ccd1',
                                    'padding': '10px', 'border-radius': '4px'
                                });
                                $p31Box.append($('<div>').css({'font-weight': 'bold', 'font-size': '13px'}).text('Seleccione la clase asociada (P31) para este esquema:'));

                                selectedP31QID = p31Candidates[0].qid;
                                p31Candidates.forEach((cand, idx) => {
                                    let schemaId = p31ClaimsMap[cand.qid];
                                    let radId = `p31-cand-${cand.qid}-${idx}`;
                                    let $rad = $('<input>').attr({
                                        type: 'radio', name: 'p31-candidate', id: radId, value: cand.qid, checked: idx === 0
                                    }).on('change', function() {
                                        selectedP31QID = cand.qid;
                                        updateSchemaExistenceCheck(cand.qid);
                                    });
                                    let badgeHtml = schemaId
                                        ? `<span style="background:#fcf2f2; color:#b32424; border:1px solid #d33; padding:1px 6px; border-radius:3px; font-size:11px; margin-left:6px;">⚠️ Ya existe: <strong>${schemaId}</strong></span>`
                                        : '';
                                    let $lbl = $('<label>').attr('for', radId).css({'font-size': '13px', 'display': 'flex', 'align-items': 'center', 'gap': '6px', 'cursor': 'pointer'})
                                        .append($rad).append($('<span>').html(`${cand.label} (${cand.qid}) ${badgeHtml}`));
                                    $p31Box.append($lbl);
                                });
                                $resultArea.append($p31Box);
                            } else {
                                selectedP31QID = qid;
                            }

                            // Checkboxes to select properties
                            let $propSelectorTitle = $('<div>').css({'font-weight': 'bold', 'font-size': '13px', 'margin-top': '4px'}).text('Selecciona las propiedades a importar:');
                            $resultArea.append($propSelectorTitle);

                            let $propListContainer = $('<div>').css({
                                'display': 'flex', 'flex-direction': 'column', 'gap': '4px',
                                'max-height': '150px', 'overflow-y': 'auto', 'border': '1px solid #c8ccd1',
                                'padding': '8px', 'border-radius': '4px', 'background': '#fff'
                            });

                            let $selectAllCheckbox = $('<input>').attr({ type: 'checkbox', id: 'cradle-select-all-props', checked: true });
                            let $selectAllRow = $('<div>').css({'font-weight': 'bold', 'margin-bottom': '4px', 'padding-bottom': '4px', 'border-bottom': '1px solid #eaecf0'})
                                .append($('<label>').css({'cursor': 'pointer', 'display': 'inline-flex', 'align-items': 'center', 'gap': '6px', 'font-size': '12px'}).append($selectAllCheckbox).append($('<span>').text('Seleccionar todas')));
                            $propListContainer.append($selectAllRow);

                            let propCBs = {};
                            fetchedPropPIDs.forEach(pid => {
                                let propLbl = labelsMap[pid] ? `${labelsMap[pid]} (${pid})` : pid;
                                let freqBadge = recoinFreqMap[pid]
                                    ? `<span style="background:#eaf3ff; color:#36c; border:1px solid #36c; padding:1px 6px; border-radius:3px; font-size:11px; margin-left:6px; font-weight:bold;">${recoinFreqMap[pid]}</span>`
                                    : '';
                                let $cb = $('<input>').attr({ type: 'checkbox', id: `cb-import-${pid}`, checked: true });
                                propCBs[pid] = $cb;
                                let $itemLabel = $('<label>').css({'display': 'flex', 'align-items': 'center', 'gap': '6px', 'font-size': '12px', 'cursor': 'pointer'})
                                    .append($cb).append($('<span>').html(`${propLbl} ${freqBadge}`));
                                $propListContainer.append($itemLabel);
                            });

                            $selectAllCheckbox.on('change', function() {
                                let isChecked = $(this).is(':checked');
                                fetchedPropPIDs.forEach(pid => {
                                    if (propCBs[pid]) propCBs[pid].prop('checked', isChecked);
                                });
                            });

                            $resultArea.append($propListContainer);

                            if (recoinData && recoinData.Frequenct_properties) {
                                let $recoinCreditFooter = $('<div>').css({'font-size': '11px', 'color': '#54595d', 'margin-top': '8px', 'margin-bottom': '4px', 'text-align': 'center', 'font-style': 'italic'})
                                    .html('Frecuencia de propiedades según la clase basadas en <a href="https://www.wikidata.org/wiki/Wikidata:Recoin" target="_blank" style="color:#36c; font-weight:bold; text-decoration:underline;">Recoin</a>');
                                $resultArea.append($recoinCreditFooter);
                            }

                            $resultArea.append($duplicateNoticeBox);

                            $importConfirmBtn.on('click', function() {
                                let selectedPIDs = fetchedPropPIDs.filter(pid => propCBs[pid] && propCBs[pid].is(':checked'));
                                if (selectedPIDs.length === 0) {
                                    mw.notify('Debe seleccionar al menos una propiedad para importar.', { type: 'warn' });
                                    return;
                                }
                                $overlay.remove();
                                if (onImportCallback) {
                                    onImportCallback(selectedP31QID, selectedPIDs, labelsMap, recoinFreqMap);
                                }
                            });

                            let $btnRow = $('<div>').css({'display': 'flex', 'gap': '8px', 'align-items': 'stretch', 'width': '100%', 'margin-top': '10px'})
                                .append($importConfirmBtn)
                                .append($editExistingSchemaBtn);
                            $resultArea.append($btnRow);

                        // Trigger initial check for selected candidate
                        if (selectedP31QID) {
                            updateSchemaExistenceCheck(selectedP31QID);
                        }
                    };

                    if (p31QIDs.length > 0) {
                        let userLang = mw.config.get('wgUserLanguage') || 'en';
                        let langsToFetch = userLang === 'en' ? 'en' : `${userLang}|en`;
                        api.get({
                            action: 'wbgetentities',
                            ids: p31QIDs.join('|'),
                            props: 'claims',
                            languages: langsToFetch,
                            format: 'json'
                        }).done(function(p31Res) {
                            if (p31Res && p31Res.entities) {
                                p31QIDs.forEach(p31Id => {
                                    if (p31Res.entities[p31Id] && p31Res.entities[p31Id].claims) {
                                        let cMap = p31Res.entities[p31Id].claims;
                                        if (cMap.P12861 && cMap.P12861.length > 0) {
                                            let sId = parseEntitySchemaID(cMap.P12861[0].mainsnak?.datavalue);
                                            if (sId) p31ClaimsMap[p31Id] = sId;
                                        }
                                    }
                                });
                            }
                            p31FetchDone();
                        }).fail(function() {
                            p31FetchDone();
                        });
                    } else {
                        p31FetchDone();
                    }
                });
            });
        }).fail(function() {
            $searchBtn.prop('disabled', false).text('Cargar elemento');
            $resultArea.html('<div style="color:#d33; font-size:13px;">Error al conectar con Wikidata</div>');
        });
        });

        $overlay.append($modal);
        $('body').append($overlay);
    }

    /**
     * Render the Cradle Schema Designer UI.
     */
    function renderSchemaDesigner(editSchemaName, editSchemaData) {
        let $content = $('#cradle-content-area').empty();
        updateDrawerFooter(false);

        let isEdit = !!editSchemaName;
        let titleVal = isEdit ? editSchemaName : '';

        let $form = $('<div>').addClass('cradle-selector-box').css({'display': 'flex', 'flex-direction': 'column', 'gap': '12px'});

        let $titleInput = $('<input>').addClass('cradle-input').attr('placeholder', mw.msg('cradle-schema-title')).val(titleVal);
        if (isEdit) {
            $titleInput.attr('disabled', 'disabled');
        }

        let $descInput = $('<input>').addClass('cradle-input').attr({
            'id': 'cradle-schema-desc-input',
            'placeholder': mw.msg('cradle-schema-desc-placeholder') || 'Descripción del esquema...'
        });

        let $aliasesInput = $('<input>').addClass('cradle-input').attr({
            'id': 'cradle-schema-aliases-input',
            'placeholder': mw.msg('cradle-schema-aliases-placeholder') || 'Alias del esquema (separados por plecas |)...'
        });

        let $targetItemInput = $('<input>').addClass('cradle-input').attr({
            'id': 'cradle-schema-target-item-input',
            'placeholder': 'Ej: Q483110 (Estadio) o Q5 (Humano)'
        });
        let $targetNoticeDiv = $('<div>').css({'margin-top': '4px'});

        function checkTargetItemDuplicateSchema(qid) {
            $targetNoticeDiv.empty();
            let cleanQID = (qid || '').trim().toUpperCase();
            if (!cleanQID || !/^Q\d+$/i.test(cleanQID)) return;

            let schemaNames = Object.keys(customSchemas || {});
            let foundCustom = null;
            schemaNames.forEach(sName => {
                let sData = customSchemas[sName];
                if (sData && sData.targetItem && sData.targetItem.toUpperCase() === cleanQID) {
                    foundCustom = sName;
                }
            });

            if (foundCustom) {
                $targetNoticeDiv.html(`
                    <div style="background:#fff3cd; border:1px solid #ffe8a1; color:#856404; padding:8px 12px; border-radius:4px; font-size:12px;">
                        ⚠️ <strong>Este esquema ya existe:</strong> El elemento <strong>${cleanQID}</strong> ya está asociado a tu esquema local <em>"${foundCustom}"</em>.
                    </div>
                `);
                return;
            }

            let api = new mw.Api();
            let userLang = mw.config.get('wgUserLanguage') || 'en';
            let langs = userLang === 'en' ? 'en' : `${userLang}|en`;

            // Query entity to check claims.P12861 (EntitySchema ID)
            api.get({
                action: 'wbgetentities',
                ids: cleanQID,
                props: 'claims|labels',
                languages: langs,
                format: 'json'
            }).done(function(res) {
                if (res && res.entities && res.entities[cleanQID]) {
                    let ent = res.entities[cleanQID];
                    let claims = ent.claims || {};
                    let existingSchemaId = null;

                    if (claims.P12861 && claims.P12861.length > 0) {
                        existingSchemaId = parseEntitySchemaID(claims.P12861[0].mainsnak?.datavalue);
                    }

                    if (existingSchemaId) {
                        let itemLabel = (ent.labels && (ent.labels[userLang]?.value || ent.labels['en']?.value)) || cleanQID;
                        $targetNoticeDiv.html(`
                            <div style="background:#fcf2f2; border:1px solid #d33; color:#b32424; padding:8px 12px; border-radius:4px; font-size:12px;">
                                ⚠️ <strong>Este esquema ya existe:</strong> El elemento <strong>${itemLabel} (${cleanQID})</strong> ya tiene asociado el EntitySchema <strong><a href="/wiki/EntitySchema:${existingSchemaId}" target="_blank" style="color:#b32424; text-decoration:underline;">${existingSchemaId}</a></strong> (declaración P12861).
                            </div>
                        `);
                        return;
                    }
                }

                // Fallback: Search Wikidata EntitySchemas via MediaWiki API
                api.get({
                    action: 'wbsearchentities',
                    search: cleanQID,
                    type: 'entityschema',
                    language: userLang,
                    format: 'json'
                }).done(function(resSearch) {
                    let items = resSearch.search || [];
                    if (items.length > 0) {
                        let match = items[0];
                        $targetNoticeDiv.html(`
                            <div style="background:#fff3cd; border:1px solid #ffe8a1; color:#856404; padding:8px 12px; border-radius:4px; font-size:12px;">
                                ⚠️ <strong>Este esquema ya existe:</strong> El elemento <strong>${cleanQID}</strong> ya cuenta con el esquema registrado <a href="/wiki/EntitySchema:${match.id}" target="_blank"><strong>${match.id}</strong> (${match.label || ''})</a>.
                            </div>
                        `);
                    }
                });
            });
        }

        $targetItemInput.on('change input', function() {
            checkTargetItemDuplicateSchema($(this).val());
        });

        // Header Title Row with Importer button on top right
        let $headerTitleRow = $('<div>').css({'display': 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '4px'});
        $headerTitleRow.append($('<h3>').css({'margin': '0'}).text(mw.msg('cradle-schema-designer')));

        let $openImporterBtn = $('<button>').addClass('cdx-button cdx-button--action-progressive cdx-button--weight-quiet')
            .css({'height': '32px', 'display': 'inline-flex', 'align-items': 'center', 'gap': '6px'})
            .html(ICONS.download + ' <span>Importar desde elemento</span>')
            .on('click', function(e) {
                e.preventDefault();
                openPropertyImporterModal(fetchLabelsInBatches, function(importedTargetQID, importedPIDs, modalLabelsMap, recoinFreqMap) {
                    if (importedTargetQID && !$targetItemInput.val().trim()) {
                        $targetItemInput.val(importedTargetQID);
                        checkTargetItemDuplicateSchema(importedTargetQID);
                    }
                    
                    // Clear previous property rows so new import starts fresh
                    $propsList.empty();

                    let newPIDs = sortPropertyIDs(importedPIDs || []);
                    if (newPIDs.length === 0) {
                        mw.notify('No hay propiedades seleccionadas para importar.', { type: 'info' });
                        return;
                    }

                    fetchLabelsInBatches(newPIDs, function(freshLabelsMap) {
                        let mergedMap = Object.assign({}, modalLabelsMap || {}, freshLabelsMap || {});
                        newPIDs.forEach(pid => {
                            try {
                                renderPropRow(pid, false, '', null, null, mergedMap, recoinFreqMap);
                            } catch (err) {
                                console.error('[Cradle Importer Error]', err);
                            }
                        });
                        mw.notify(`¡Se importaron ${newPIDs.length} propiedades!`, { type: 'success' });
                    });
                });
            });
        $headerTitleRow.append($openImporterBtn);
        $form.append($headerTitleRow);

        let $headerFieldsRow = $('<div>').css({'display': 'flex', 'flex-direction': 'column', 'gap': '10px', 'margin-bottom': '12px'});

        // Row 1: Título, Descripción, Alias (|) in FULL width flex row
        let $row1 = $('<div>').css({'display': 'flex', 'gap': '8px', 'flex-wrap': 'wrap', 'align-items': 'center'});
        $row1.append($('<div>').css({'flex': '1', 'min-width': '140px'}).append($('<label>').css({'display': 'block', 'font-weight': 'bold', 'margin-bottom': '4px'}).text(mw.msg('cradle-schema-title'))).append($titleInput));
        $row1.append($('<div>').css({'flex': '1.5', 'min-width': '160px'}).append($('<label>').css({'display': 'block', 'font-weight': 'bold', 'margin-bottom': '4px'}).text('Descripción')).append($descInput));
        $row1.append($('<div>').css({'flex': '1', 'min-width': '130px'}).append($('<label>').css({'display': 'block', 'font-weight': 'bold', 'margin-bottom': '4px'}).text('Alias (|)')).append($aliasesInput));

        // Row 2: Elemento asociado (directly below Título)
        let $row2 = $('<div>').css({'display': 'flex', 'flex-direction': 'column'});
        let $row2Inner = $('<div>').css({'display': 'flex', 'gap': '8px'});
        $row2Inner.append($('<div>').css({'width': '280px', 'max-width': '100%'}).append($('<label>').css({'display': 'block', 'font-weight': 'bold', 'margin-bottom': '4px'}).text('Elemento asociado')).append($targetItemInput));
        $row2.append($row2Inner).append($targetNoticeDiv);

        $headerFieldsRow.append($row1).append($row2);
        $form.append($headerFieldsRow);

        let $propertiesDiv = $('<div>').css({
            'display': 'flex',
            'flex-direction': 'column',
            'gap': '8px',
            'border': '1px dashed #c8ccd1',
            'padding': '12px',
            'border-radius': '4px',
            'position': 'relative'
        });
        $propertiesDiv.append($('<h4>').css({'margin': '0'}).text(mw.msg('cradle-properties-list')));

        let $propsList = $('<div>').css({'display': 'flex', 'flex-direction': 'column', 'gap': '8px'});
        $propertiesDiv.append($propsList);

        // Helper to batch fetch labels for properties and items (with English fallback)
        function fetchLabelsInBatches(ids, callback) {
            let labels = {};
            let datatypes = {};
            ids = ids.filter(id => id);
            if (ids.length === 0) {
                callback(labels, datatypes);
                return;
            }
            let api = new mw.Api();
            let chunks = [];
            for (let i = 0; i < ids.length; i += 50) {
                chunks.push(ids.slice(i, i + 50));
            }
            let pending = chunks.length;
            let userLang = mw.config.get('wgUserLanguage') || 'en';
            let langsToFetch = userLang === 'en' ? 'en' : `${userLang}|en`;

            chunks.forEach(chunk => {
                let idsStr = Array.isArray(chunk) ? chunk.join('|') : chunk;
                api.get({
                    action: 'wbgetentities',
                    ids: idsStr,
                    props: 'labels|datatype',
                    languages: langsToFetch,
                    format: 'json'
                }).done(function(res) {
                    if (res && res.entities) {
                        chunk.forEach(id => {
                            if (res.entities[id]) {
                                let lObj = res.entities[id].labels || {};
                                let lbl = (lObj[userLang] && lObj[userLang].value) || (lObj['en'] && lObj['en'].value);
                                labels[id] = lbl || id;
                                if (res.entities[id].datatype) {
                                    datatypes[id] = res.entities[id].datatype;
                                    if (id.startsWith('P')) {
                                        propertyMetadata[id] = propertyMetadata[id] || {};
                                        propertyMetadata[id].label = labels[id];
                                        propertyMetadata[id].datatype = res.entities[id].datatype;
                                    }
                                }
                            } else {
                                labels[id] = id;
                            }
                        });
                    }
                    pending--;
                    if (pending === 0) callback(labels, datatypes);
                }).fail(function() {
                    chunk.forEach(id => { labels[id] = id; });
                    pending--;
                    if (pending === 0) callback(labels, datatypes);
                });
            });
        }

        function renderPropRow(pid, mandatory, defaultValue, hardselectQIDs, softselectQIDs, labelsMap, recoinFreqMap) {
            labelsMap = labelsMap || {};
            recoinFreqMap = recoinFreqMap || {};
            let propLabel = labelsMap[pid] ? ` (${labelsMap[pid]})` : '';
            let freqStr = recoinFreqMap[pid] ? recoinFreqMap[pid] : '';
            let freqBadge = freqStr ? `<span style="background:#eaf3ff; color:#36c; border:1px solid #36c; padding:2px 6px; border-radius:3px; font-size:11px; margin-left:8px; font-weight:bold;">${freqStr}</span>` : '';
            let uniqueRowId = Math.random().toString(36).substring(2, 9);

            let $row = $('<div>').addClass('cradle-prop-row-builder').css({
                'display': 'flex',
                'flex-direction': 'column',
                'gap': '8px',
                'padding': '10px',
                'background': '#f8f9fa',
                'border-radius': '4px',
                'border': '1px solid #a2a9b1',
                'position': 'relative'
            });

            // Header line
            let $headerRow = $('<div>').css({'display': 'flex', 'justify-content': 'space-between', 'align-items': 'center'});
            $headerRow.append($('<strong>').css({'font-size': '14px'}).html(pid + propLabel + ' ' + freqBadge));
            let $remove = $('<button>').addClass('cradle-btn-secondary').css({'padding': '2px 6px', 'color': '#d33', 'font-weight': 'bold'}).html(ICONS.close).on('click', function() {
                $row.remove();
            });
            $headerRow.append($remove);
            $row.append($headerRow);

            // Cardinality selection dropdown
            let $optionsRow = $('<div>').css({'display': 'flex', 'gap': '12px', 'align-items': 'center'});
            let $cardinalitySelect = $('<select>').addClass('cradle-select').css({
                'font-size': '12px',
                'height': '28px',
                'padding': '2px 6px',
                'width': 'auto'
            });
            $cardinalitySelect.append($('<option>').val('1').text('1 (Obligatorio, único)'));
            $cardinalitySelect.append($('<option>').val('?').text('0..1 / ? (Opcional, único)'));
            $cardinalitySelect.append($('<option>').val('+').text('1..* / + (Obligatorio, múltiple)'));
            $cardinalitySelect.append($('<option>').val('*').text('0..* / * (Opcional, múltiple)'));

            let initialCard = '1';
            if (mandatory) initialCard = '1';
            else initialCard = '?';
            $cardinalitySelect.val(initialCard);

            let $cardinalityLabel = $('<label>').css({
                'display': 'flex',
                'align-items': 'center',
                'gap': '6px',
                'font-size': '12px',
                'font-weight': 'bold',
                'color': '#202122'
            }).text('Cardinalidad: ').append($cardinalitySelect);

            $optionsRow.append($cardinalityLabel);
            $row.append($optionsRow);

            // Selection options layout: Radio buttons for Value type
            let isHard = !!hardselectQIDs || (defaultValue && defaultValue.startsWith('Q'));
            let isSoft = !isHard && !!softselectQIDs;
            let activePreset = 'none';
            if (isHard) activePreset = 'hard';
            else if (isSoft) activePreset = 'soft';

            let $radioGroup = $('<div>').css({'display': 'flex', 'gap': '12px', 'margin-top': '4px'});
            
            let $radioNone = $('<input>').attr({
                type: 'radio',
                name: `select-type-${uniqueRowId}`,
                id: `none-${uniqueRowId}`,
                checked: (activePreset === 'none')
            });
            let $labelNone = $('<label>').attr('for', `none-${uniqueRowId}`).css({'font-size': '12px', 'display': 'flex', 'align-items': 'center', 'gap': '4px'})
                .append($radioNone).append(mw.msg('cradle-preset-none'));

            let $radioHard = $('<input>').attr({
                type: 'radio',
                name: `select-type-${uniqueRowId}`,
                id: `hard-${uniqueRowId}`,
                checked: (activePreset === 'hard')
            });
            let $labelHard = $('<label>').attr('for', `hard-${uniqueRowId}`).css({'font-size': '12px', 'display': 'flex', 'align-items': 'center', 'gap': '4px'})
                .append($radioHard).append(mw.msg('cradle-hardselect-label'));

            let $radioSoft = $('<input>').attr({
                type: 'radio',
                name: `select-type-${uniqueRowId}`,
                id: `soft-${uniqueRowId}`,
                checked: (activePreset === 'soft')
            });
            let $labelSoft = $('<label>').attr('for', `soft-${uniqueRowId}`).css({'font-size': '12px', 'display': 'flex', 'align-items': 'center', 'gap': '4px'})
                .append($radioSoft).append(mw.msg('cradle-softselect-label'));

            $radioGroup.append($labelNone).append($labelHard).append($labelSoft);
            $row.append($radioGroup);

            // Container for preset value options
            let $valuePresetContainer = $('<div>').css({'display': 'flex', 'flex-direction': 'column', 'gap': '6px'});
            
            // Chips Container
            let $chipsDiv = $('<div>').css({'display': 'flex', 'flex-wrap': 'wrap', 'gap': '6px', 'margin-top': '4px'});
            $valuePresetContainer.append($chipsDiv);

            let selectedItems = []; // List of { qid, label }

            function addChip(qid, label) {
                let useHard = $radioHard.is(':checked');
                if (selectedItems.some(i => i.qid === qid)) return;
                selectedItems.push({ qid: qid, label: label });

                let $chip = $('<span>').css({
                    'display': 'inline-flex',
                    'align-items': 'center',
                    'gap': '6px',
                    'background': '#eaecf0',
                    'border': '1px solid #c8ccd1',
                    'border-radius': '3px',
                    'padding': '3px 8px',
                    'font-size': '12px'
                }).text(`${label} (${qid})`);

                let $removeChip = $('<span>').css({
                    'cursor': 'pointer',
                    'color': '#72777d',
                    'font-weight': 'bold',
                    'margin-left': '4px'
                }).html(ICONS.close).on('click', function() {
                    selectedItems = selectedItems.filter(item => item.qid !== qid);
                    $chip.remove();
                    updateSearchInputVisibility();
                });

                $chip.append($removeChip);
                $chipsDiv.append($chip);
                updateSearchInputVisibility();
            }

            // Populate existing values on edit
            if (isHard) {
                let qids = hardselectQIDs || (defaultValue ? [defaultValue] : []);
                qids.forEach(qid => {
                    if (qid) addChip(qid, labelsMap[qid] || qid);
                });
            } else if (isSoft) {
                softselectQIDs.forEach(qid => {
                    addChip(qid, labelsMap[qid] || qid);
                });
            }

            // Autocomplete search input group
            let $valSearchGroup = $('<div>').css({'position': 'relative', 'margin-top': '4px'});
            let $valSearchInput = $('<input>').addClass('cradle-input').css({'height': '36px', 'padding': '2px 8px', 'font-size': '13px'})
                .attr('placeholder', mw.msg('cradle-search-value-placeholder'));
            $valSearchGroup.append($valSearchInput);

            let $valAutocompleteMenu = $('<ul>').css({
                'position': 'absolute',
                'top': '100%',
                'left': '0',
                'right': '0',
                'background': '#fff',
                'border': '1px solid #a2a9b1',
                'border-radius': '0 0 4px 4px',
                'box-shadow': '0 2px 4px rgba(0,0,0,0.15)',
                'max-height': '150px',
                'overflow-y': 'auto',
                'z-index': '1010',
                'list-style': 'none',
                'margin': '0',
                'padding': '0',
                'display': 'none'
            });
            $valSearchGroup.append($valAutocompleteMenu);
            $valuePresetContainer.append($valSearchGroup);
            $row.append($valuePresetContainer);

            // Bind autocomplete searches for select item values
            let valDebounce;
            $valSearchInput.on('input', function() {
                clearTimeout(valDebounce);
                let val = $valSearchInput.val().trim();
                if (val.length < 2) {
                    $valAutocompleteMenu.hide().empty();
                    return;
                }
                valDebounce = setTimeout(function() {
                    let api = new mw.Api();
                    logDebug('[Cradle Designer] Searching value preset:', val);
                    api.get({
                        action: 'wbsearchentities',
                        search: val,
                        language: mw.config.get('wgUserLanguage') || 'en',
                        type: 'item',
                        format: 'json'
                    }).done(function(res) {
                        $valAutocompleteMenu.empty();
                        let items = res.search || [];
                        if (items.length === 0) {
                            $valAutocompleteMenu.hide();
                            return;
                        }
                        items.forEach(item => {
                            let desc = item.description ? ` - ${item.description}` : '';
                            let $li = $('<li>').css({
                                'padding': '6px 10px',
                                'cursor': 'pointer',
                                'border-bottom': '1px solid #eaecf0',
                                'font-size': '12px'
                            })
                            .html(`<strong>${item.id}</strong>: ${item.label}${desc}`)
                            .on('click', function() {
                                addChip(item.id, item.label);
                                $valSearchInput.val('');
                                $valAutocompleteMenu.hide().empty();
                            })
                            .on('mouseenter', function() { $(this).css('background', '#f8f9fa'); })
                            .on('mouseleave', function() { $(this).css('background', '#fff'); });
                            $valAutocompleteMenu.append($li);
                        });
                        $valAutocompleteMenu.show();
                    });
                }, 300);
            });

            function updateSearchInputVisibility() {
                let useNone = $radioNone.is(':checked');
                if (useNone) {
                    $valuePresetContainer.hide();
                } else {
                    $valuePresetContainer.show();
                    $valSearchGroup.show();
                }
            }

            $radioNone.on('change', function() {
                selectedItems = [];
                $chipsDiv.empty();
                updateSearchInputVisibility();
            });
            $radioHard.on('change', function() {
                updateSearchInputVisibility();
            });
            $radioSoft.on('change', function() {
                updateSearchInputVisibility();
            });

            // Set initial visibility
            updateSearchInputVisibility();

            $(document).on('click', function(e) {
                if (!$(e.target).closest($valSearchGroup).length) {
                    $valAutocompleteMenu.hide();
                }
            });

            $row.data('pid', pid);
            $row.data('get_data', function() {
                let qidString = selectedItems.map(i => i.qid).join(',');
                let useHard = $radioHard.is(':checked');
                let useSoft = $radioSoft.is(':checked');
                let cardVal = $cardinalitySelect.val();
                return {
                    pid: pid,
                    cardinality: cardVal,
                    mandatory: (cardVal === '1' || cardVal === '+'),
                    allowMultiple: (cardVal === '+' || cardVal === '*'),
                    defaultValue: '',
                    hardselect: (useHard && qidString) ? qidString : '',
                    softselect: (useSoft && qidString) ? qidString : ''
                };
            });

            $propsList.append($row);
        }

        // Initialize designer: Gather edit details and load labels in a single batch
        let editPIDs = isEdit ? Object.keys(editSchemaData.props) : [];
        let qidsToFetch = [];
        if (isEdit && editSchemaData.props) {
            editPIDs.forEach(pid => {
                qidsToFetch.push(pid);
                let p = editSchemaData.props[pid];
                if (p.defaultValue && p.defaultValue.startsWith('Q')) qidsToFetch.push(p.defaultValue);
                if (p.hardselect) qidsToFetch = qidsToFetch.concat(p.hardselect);
                if (p.softselect) qidsToFetch = qidsToFetch.concat(p.softselect);
            });
        }
        qidsToFetch = [...new Set(qidsToFetch)].filter(id => /^[QP]\d+$/.test(id));

        fetchLabelsInBatches(qidsToFetch, function(labelsMap) {
            if (isEdit && editSchemaData.props) {
                editPIDs.forEach(pid => {
                    let p = editSchemaData.props[pid];
                    let isMandatory = p.mandatory === true || p.mandatory === 1 || p.mandatory === '1';
                    let defVal = p.defaultValue || '';
                    let hSel = p.hardselect || null;
                    let sSel = p.softselect || null;
                    renderPropRow(pid, isMandatory, defVal, hSel, sSel, labelsMap);
                });
            }
        });

        let $addPropGroup = $('<div>').css({'display': 'flex', 'flex-direction': 'column', 'gap': '4px', 'margin-top': '8px', 'position': 'relative'});
        let $addPropInput = $('<input>').addClass('cradle-input').attr('placeholder', mw.msg('cradle-prop-search-placeholder'));
        $addPropGroup.append($addPropInput);

        let $autocompleteMenu = $('<ul>').css({
            'position': 'absolute',
            'top': '100%',
            'left': '0',
            'right': '0',
            'background': '#fff',
            'border': '1px solid #a2a9b1',
            'border-radius': '0 0 4px 4px',
            'box-shadow': '0 2px 4px rgba(0,0,0,0.15)',
            'max-height': '200px',
            'overflow-y': 'auto',
            'z-index': '1000',
            'list-style': 'none',
            'margin': '0',
            'padding': '0',
            'display': 'none'
        });
        $addPropGroup.append($autocompleteMenu);
        $propertiesDiv.append($addPropGroup);
        $form.append($propertiesDiv);
        $content.append($form);

        let debounceTimer;
        $addPropInput.on('input', function() {
            clearTimeout(debounceTimer);
            let val = $addPropInput.val().trim();
            if (val.length < 2) {
                $autocompleteMenu.hide().empty();
                return;
            }
            debounceTimer = setTimeout(function() {
                let api = new mw.Api();
                logDebug('[Cradle Designer] Searching property:', val);
                api.get({
                    action: 'wbsearchentities',
                    search: val,
                    language: mw.config.get('wgUserLanguage') || 'en',
                    type: 'property',
                    format: 'json'
                }).done(function(res) {
                    $autocompleteMenu.empty();
                    let items = res.search || [];
                    if (items.length === 0) {
                        $autocompleteMenu.hide();
                        return;
                    }
                    items.forEach(item => {
                        let desc = item.description ? ` - ${item.description}` : '';
                        let $li = $('<li>').css({
                            'padding': '8px 12px',
                            'cursor': 'pointer',
                            'border-bottom': '1px solid #eaecf0',
                            'font-size': '13px'
                        })
                        .html(`<strong>${item.id}</strong>: ${item.label}${desc}`)
                        .on('click', function() {
                            let map = {};
                            map[item.id] = item.label;
                            renderPropRow(item.id, false, '', null, null, map);
                            $addPropInput.val('');
                            $autocompleteMenu.hide().empty();
                        })
                        .on('mouseenter', function() { $(this).css('background', '#f8f9fa'); })
                        .on('mouseleave', function() { $(this).css('background', '#fff'); });
                        $autocompleteMenu.append($li);
                    });
                    $autocompleteMenu.show();
                });
            }, 300);
        });

        $(document).on('click', function(e) {
            if (!$(e.target).closest($addPropGroup).length) {
                $autocompleteMenu.hide();
            }
        });

        function gatherDesignerProps() {
            let propRows = [];
            $propsList.children().each(function() {
                let rowData = $(this).data('get_data')();
                propRows.push(rowData);
            });
            return propRows;
        }

        let $footer = $('#cradle-footer-area').empty().css({
            'display': 'flex',
            'flex-direction': 'row',
            'justify-content': 'space-between',
            'align-items': 'center',
            'gap': '8px',
            'padding': '12px 16px'
        });

        let $cancelBtn = $('<button>').addClass('cradle-btn-secondary').html(ICONS.back + ' <span>' + mw.msg('cradle-back') + '</span>').on('click', function() {
            renderCreateOptionsSelector();
        });

        let $saveBtn = $('<button>').addClass('cradle-btn-primary').text(mw.msg('cradle-create-entityschema-btn')).on('click', function() {
            let name = $titleInput.val().trim() || 'CustomSchema';
            let targetQID = $targetItemInput.val().trim();
            let propRows = gatherDesignerProps();
            if (propRows.length === 0) {
                mw.notify(mw.msg('cradle-schema-prop-required'), { type: 'error' });
                return;
            }
            let pids = propRows.map(r => r.pid);
            fetchLabelsInBatches(pids, function(labelsMap) {
                openShExExportModal(name, propRows, labelsMap, targetQID);
            });
        });

        let $exportShexBtn = $('<button>')
            .addClass('cradle-btn-secondary')
            .text(mw.msg('cradle-export-shex'))
            .on('click', function() {
                let name = $titleInput.val().trim() || 'CustomSchema';
                let targetQID = $targetItemInput.val().trim();
                let propRows = gatherDesignerProps();
                if (propRows.length === 0) {
                    mw.notify(mw.msg('cradle-schema-prop-required'), { type: 'error' });
                    return;
                }
                let pids = propRows.map(r => r.pid);
                fetchLabelsInBatches(pids, function(labelsMap) {
                    openShExExportModal(name, propRows, labelsMap, targetQID);
                });
            });

        let $leftGroup = $('<div>').append($cancelBtn);
        let $rightGroup = $('<div>').css({'display': 'flex', 'gap': '8px', 'align-items': 'center'}).append($exportShexBtn).append($saveBtn);

        $footer.append($leftGroup).append($rightGroup);
    }
    
    $(document).ready(function() {
        mw.loader.using(['mediawiki.api', 'mediawiki.util', 'mediawiki.storage', 'mediawiki.jqueryMsg']).then(init);
    });

})();

