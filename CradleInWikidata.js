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
 * Version: 1.14.2
 * 
 * Installation:
 * Add the following line to your [[Special:MyPage/common.js]] on Wikidata (increment version value to bypass cache):
 * mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.14.2');
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

        /* Wikimedia-styled flat side panel */
        .cradle-drawer {
            position: fixed;
            top: 0;
            right: -480px;
            width: 440px;
            height: 100vh;
            background-color: var(--background-color-base, #ffffff);
            border-left: 1px solid var(--border-color-base, #a2a9b1);
            box-shadow: -4px 0 16px rgba(0, 0, 0, 0.15);
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
        
        /* Form fields cards - Flat Wikimedia styling */
        .cradle-field-card {
            background-color: var(--background-color-base, #ffffff);
            border: 1px solid var(--border-color-base, #a2a9b1);
            border-radius: 2px;
            padding: 16px;
            margin-bottom: 16px;
            transition: border-color 0.2s ease;
            position: relative;
        }
        .cradle-field-card:hover {
            border-color: var(--border-color-progressive, #36c);
        }
        .cradle-field-card.mandatory {
            border-left: 3px solid var(--border-color-progressive, #36c);
        }
        .cradle-field-card.valid {
            border-left: 4px solid var(--color-success, #00af89) !important;
        }
        .cradle-field-card.invalid {
            border-left: 4px solid var(--color-destructive, #d33) !important;
            background-color: rgba(211, 51, 51, 0.01);
        }
        .cradle-field-card.optional-present {
            border-left: 4px solid var(--color-progressive, #36c) !important;
        }
        .cradle-field-card.optional-missing {
            border-left: 4px solid var(--color-warning, #fc3) !important;
            background-color: var(--background-color-warning-subtle, #fef8ee);
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
            width: 60px !important;
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
        .cradle-row.deleted .cradle-btn-delete:hover {
            background-color: rgba(51, 102, 204, 0.05);
            border-color: rgba(51, 102, 204, 0.15);
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
            'cradle-new-item-identity-desc': 'Provide the label and description for the new Wikidata item.',
            'cradle-new-item-label': 'Enter item label (e.g. Marie Curie)...',
            'cradle-new-item-desc': 'Enter item description (e.g. Polish-French physicist)...',
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
            'cradle-edit-summary': 'Updated statements using Cradle Wikidata Gadget (EntitySchema:$1)',
            'cradle-create-summary': 'Created new item using Cradle Wikidata Gadget (Template: $1)',
            'cradle-search-placeholder': 'Search item...',
            'cradle-credits': 'Created by $1 & $2. Based on $3 by $4.',
            'cradle-hardselect-placeholder': 'hardselect QIDs (comma-separated, e.g. Q5,Q6)',
            'cradle-softselect-placeholder': 'softselect QIDs (comma-separated, e.g. Q5,Q6)',
            'cradle-schema-title-required': 'Schema title is required!',
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
            'cradle-tab-custom': 'Custom Schemas',
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
            'cradle-required-checkbox': 'Required'
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
                    'cradle-new-item-identity-desc': 'Proporciona la etiqueta y descripción para el nuevo elemento de Wikidata.',
                    'cradle-new-item-label': 'Introduce la etiqueta del elemento (ej. Marie Curie)...',
                    'cradle-new-item-desc': 'Introduce la descripción del elemento (ej. física polaca-francesa)...',
                    'cradle-add-value': 'Añadir valor',
                    'cradle-save-changes': 'Guardar cambios',
                    'cradle-create-item': 'Crear elemento',
                    'cradle-cancel': 'Cancelar',
                    'cradle-select-predefined': '-- Selecciona un formulario predefinido --',
                    'cradle-method-predefined': 'Método 1: Usar un formulario predefinido de Cradle',
                    'cradle-method-schema': 'Método 2: Usar un ID de EntitySchema (ShEx)',
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
                    'cradle-edit-summary': 'Declaraciones actualizadas con el gadget Cradle de Wikidata (EntitySchema:$1)',
                    'cradle-create-summary': 'Nuevo elemento creado con el gadget Cradle de Wikidata (Plantilla: $1)',
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
                    'cradle-val-err-num': 'Número no válido: $1'
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
        
        // Add Toolbox portlet link in the sidebar on all pages
        mw.util.addPortletLink(
            'p-tb',
            mw.util.getUrl('Special:Cradle'),
            'Cradle',
            't-cradle',
            'Create items using Cradle templates or schemas'
        );

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
     * Searches class properties (P12861) on P31 and P279 claims of the entity.
     */
    function findAssociatedSchemas(data) {
        let schemas = [];
        
        // Direct schema on this item
        if (data.claims && data.claims[P12861]) {
            data.claims[P12861].forEach(claim => {
                if (claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value) {
                    schemas.push(claim.mainsnak.datavalue.value.id);
                }
            });
        }

        // Check instance of (P31) and subclass of (P279)
        let classesToCheck = [];
        [P31, P279].forEach(prop => {
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
                                if (claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value) {
                                    let schemaId = claim.mainsnak.datavalue.value.id;
                                    if (schemaId && !schemas.includes(schemaId)) {
                                        schemas.push(schemaId);
                                    }
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
     * Renders selection panel for Create mode (Template or Schema).
     */
    function renderCreateOptionsSelector() {
        let $content = $('#cradle-content-area').empty();
        updateDrawerFooter(false);
        
        $content.append($('<div>').css({'text-align': 'center', 'margin-top': '20px'})
            .append($('<div>').addClass('cradle-spinner').css({'border-top-color': 'var(--border-color-progressive, #36c)'}))
            .append($('<p>').text(mw.msg('cradle-loading-templates')))
        );

        loadCradleWikitext().then(wikitext => {
            cradleTemplates = parseCradleWikitext(wikitext);
            $content.empty();

            // Render Tabs Header using dedicated responsive classes
            let $tabsHeader = $('<div>').addClass('cradle-select-tabs');

            let tabs = [
                { id: 'predefined', label: mw.msg('cradle-tab-predefined') },
                { id: 'shex', label: mw.msg('cradle-tab-shex') },
                { id: 'custom', label: mw.msg('cradle-tab-custom') }
            ];

            let activeTab = mw.storage.get('cradle-active-tab') || 'predefined';

            tabs.forEach(tab => {
                let $tab = $('<button>')
                    .addClass('cradle-select-tab')
                    .text(tab.label)
                    .on('click', function() {
                        mw.storage.set('cradle-active-tab', tab.id);
                        renderCreateOptionsSelector();
                    });
                if (activeTab === tab.id) {
                    $tab.addClass('active');
                }
                $tabsHeader.append($tab);
            });
            $content.append($tabsHeader);

            // Tab Panels
            if (activeTab === 'predefined') {
                let $box = $('<div>').addClass('cradle-selector-box');
                $box.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-method-predefined')));
                
                let $select = $('<select>').addClass('cradle-select');
                $select.append($('<option>').val('').text(mw.msg('cradle-select-predefined')));
                
                Object.keys(cradleTemplates).sort().forEach(key => {
                    let t = cradleTemplates[key];
                    let label = t.labels[mw.config.get('wgUserLanguage')] || t.title;
                    $select.append($('<option>').val(key).text(label));
                });
                $box.append($select);
                $content.append($box);
                
                $select.on('change', function() {
                    let key = $select.val();
                    if (key) {
                        loadAndDisplayTemplate(key);
                    }
                });
            } else if (activeTab === 'custom') {
                let $customBox = $('<div>').addClass('cradle-selector-box');
                $customBox.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-custom-schemas')));
                
                let $customList = $('<div>').css({'max-height': '200px', 'overflow-y': 'auto', 'margin-bottom': '10px'});
                $customBox.append($customList);

                let userName = mw.config.get('wgUserName');
                if (userName) {
                    let $createBtn = $('<button>')
                        .addClass('cradle-btn-secondary')
                        .css({'width': '100%', 'margin-bottom': '10px', 'font-weight': 'bold', 'background': '#36c', 'color': '#fff'})
                        .text(mw.msg('cradle-create-schema'))
                        .on('click', function() {
                            renderSchemaDesigner();
                        });
                    $customBox.prepend($createBtn);

                    fetchUserSchemas(function(sections) {
                        $customList.empty();
                        let keys = Object.keys(sections);
                        if (keys.length === 0) {
                            $customList.append($('<p>').css({'font-style': 'italic', 'color': '#72777d'}).text(mw.msg('cradle-no-custom-schemas')));
                        } else {
                            keys.forEach(key => {
                                let schemaName = key;
                                let $row = $('<div>').css({
                                    'display': 'flex',
                                    'justify-content': 'space-between',
                                    'align-items': 'center',
                                    'padding': '6px 0',
                                    'border-bottom': '1px solid #eaecf0'
                                });
                                $row.append($('<span>').text(schemaName));
                                
                                let $actions = $('<div>').css({'display': 'flex', 'gap': '4px'});
                                let $load = $('<button>').addClass('cradle-btn-secondary').css({'padding': '2px 6px', 'font-size': '12px'}).text(mw.msg('cradle-btn-load')).on('click', function() {
                                    let data = parseCradleWikitext(sections[schemaName]);
                                    cradleTemplates[schemaName.toLowerCase().replace(/ /g, '_')] = {
                                        title: schemaName,
                                        labels: data.labels,
                                        props: data.props
                                    };
                                    loadAndDisplayTemplate(schemaName.toLowerCase().replace(/ /g, '_'));
                                });
                                let $edit = $('<button>').addClass('cradle-btn-secondary').css({'padding': '2px 6px', 'font-size': '12px'}).text(mw.msg('cradle-btn-edit')).on('click', function() {
                                    let data = parseCradleWikitext(sections[schemaName]);
                                    renderSchemaDesigner(schemaName, data);
                                });
                                let $del = $('<button>').addClass('cradle-btn-secondary').css({'padding': '2px 6px', 'font-size': '12px', 'color': '#d33'}).text(mw.msg('cradle-btn-delete')).on('click', function() {
                                    if (confirm(mw.msg('cradle-delete-schema-confirm', schemaName))) {
                                        deleteSchemaFromPage(schemaName);
                                    }
                                });
                                $actions.append($load).append($edit).append($del);
                                $row.append($actions);
                                $customList.append($row);
                            });
                        }
                    });
                } else {
                    $customList.append($('<p>').css({'font-style': 'italic', 'color': '#72777d'}).text(mw.msg('cradle-login-required-schema')));
                }
                $content.append($customBox);

                let $communityBox = $('<div>').addClass('cradle-selector-box').css({'margin-top': '15px'});
                $communityBox.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-search-community')));
                
                let $searchGroup = $('<div>').css({'display': 'flex', 'gap': '8px'});
                let $searchBar = $('<input>').addClass('cradle-input').attr('placeholder', mw.msg('cradle-search-placeholder-community'));
                let $searchBtn = $('<button>').addClass('cradle-btn-secondary').text(mw.msg('cradle-search-btn'));
                $searchGroup.append($searchBar).append($searchBtn);
                $communityBox.append($searchGroup);
                
                let $resultsDiv = $('<div>').css({'margin-top': '10px', 'max-height': '200px', 'overflow-y': 'auto'});
                $communityBox.append($resultsDiv);
                
                $searchBtn.on('click', function() {
                    let query = $searchBar.val().trim();
                    $resultsDiv.empty().append($('<p>').text(mw.msg('cradle-searching')));
                    searchCommunitySchemas(query, function(results) {
                        $resultsDiv.empty();
                        if (results.length === 0) {
                            $resultsDiv.append($('<p>').css({'font-style': 'italic', 'color': '#72777d'}).text(mw.msg('cradle-no-results')));
                        } else {
                            results.forEach(res => {
                                let $row = $('<div>').css({
                                    'display': 'flex',
                                    'justify-content': 'space-between',
                                    'align-items': 'center',
                                    'padding': '6px 0',
                                    'border-bottom': '1px solid #eaecf0'
                                });
                                $row.append($('<div>')
                                    .append($('<strong>').text(res.name))
                                    .append($('<span>').css({'font-size': '11px', 'color': '#72777d', 'margin-left': '8px'}).text('by ' + res.author))
                                );
                                
                                let $loadComm = $('<button>').addClass('cradle-btn-secondary').css({'padding': '2px 6px', 'font-size': '12px'}).text(mw.msg('cradle-btn-load')).on('click', function() {
                                    loadAndDisplayUserSchema(res.title, res.name);
                                });
                                $row.append($loadComm);
                                $resultsDiv.append($row);
                            });
                        }
                    });
                });
                $content.append($communityBox);
            } else if (activeTab === 'shex') {
                let $boxSchema = $('<div>').addClass('cradle-selector-box');
                $boxSchema.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-method-schema')));
                
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

                let $group = $('<div>').css({'display': 'flex', 'gap': '8px', 'margin-top': '8px'});
                $schemaInput.css({'flex': '1'});
                $group.append($schemaInput).append($schemaBtn);
                $boxSchema.append($group);

                attachEntitySchemaAutocompleter($group, $schemaInput, function(schemaId) {
                    loadAndDisplaySchema(schemaId);
                });
                $content.append($boxSchema);
            }
        }).catch(err => {
            console.error(err);
            $content.empty().append($('<div>').addClass('cradle-selector-box').css('border-color', 'var(--color-destructive, #d33)')
                .append($('<p>').css({'color': 'var(--color-destructive, #d33)', 'font-weight': 'bold'}).text('Error loading predefined templates'))
                .append($('<p>').text(err.message))
            );
        });
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
        
        // Find shape contents
        let shapes = {};
        let shapeRegex = /<([^>]+)>\s*(?:EXTRA\s+[^{]+)?\s*\{([\s\S]*?)\}/gi;
        let match;
        while ((match = shapeRegex.exec(shexText)) !== null) {
            let shapeName = match[1];
            let shapeContent = match[2];
            shapes[shapeName] = shapeContent;
            if (!startShape) {
                startShape = shapeName;
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
                            datatype: ent.datatype
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
            }
        });
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
            let timeStr = val.time;
            if (timeStr.startsWith('+') || timeStr.startsWith('-')) {
                timeStr = timeStr.substring(1);
            }
            if (timeStr.endsWith('T00:00:00Z')) {
                timeStr = timeStr.replace('T00:00:00Z', '');
            }
            return timeStr;
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
            if (max !== '*' && activeClaims.length > max) {
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

        // 2. Update each card
        Object.keys(val.properties).forEach(pid => {
            let propVal = val.properties[pid];
            let $card = $(`#cradle-card-${pid}`);
            if (!$card.length) return;

            // Update card border classes
            $card.removeClass('valid invalid optional-present optional-missing')
                 .addClass(propVal.itemClass);

            // Update badge icon next to title
            $card.find('.cradle-card-validation-badge').html(propVal.badgeHtml);

            // Update card error text list
            $card.find('.cradle-field-errors').remove();
            if (propVal.errors.length > 0) {
                let $errList = $('<div>').addClass('cradle-field-errors').css({
                    'color': 'var(--color-destructive, #d33)',
                    'font-size': '0.75rem',
                    'margin-top': '8px',
                    'font-weight': 'bold',
                    'line-height': '1.3'
                });
                propVal.errors.forEach(err => {
                    $errList.append($('<div>').css({'display': 'flex', 'align-items': 'center', 'gap': '4px'}).html(ICONS.alert + ' <span>' + err + '</span>'));
                });
                $(`#cradle-rows-${pid}`).after($errList);
            }
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
        let propIds = Object.keys(schemaProperties);

        // Render back button
        let $headerPanel = $('<div>').css({'display': 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '16px'});
        $headerPanel.append($('<button>').addClass('cradle-btn-secondary').html(ICONS.back + ' <span>' + mw.msg('cradle-change-form') + '</span>').on('click', changeActiveForm));
        $content.append($headerPanel);

        // Display current active schema/template title
        let activeTitle = "";
        if (activeTemplate) {
            activeTitle = activeTemplate.labels[mw.config.get('wgUserLanguage')] || activeTemplate.title;
        } else if (activeSchema) {
            activeTitle = `${activeSchema.label} (${activeSchema.id})`;
        }

        if (activeTitle) {
            let $formHeader = $('<div>')
                .css({
                    'margin-bottom': '20px',
                    'padding-bottom': '8px'
                })
                .append($('<h2>').css({
                    'font-size': '1.25rem',
                    'margin': '0',
                    'font-weight': 'bold',
                    'color': 'var(--color-base, #202122)'
                }).text(activeTitle));
            $content.append($formHeader);
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

        // For Create Mode: Ingest Label and Description inputs
        if (activeMode === 'create') {
            let $metaCard = $('<div>').addClass('cradle-field-card').addClass('mandatory');
            $metaCard.append($('<h3>').addClass('cradle-field-title').text(mw.msg('cradle-new-item-identity')));
            $metaCard.append($('<p>').addClass('cradle-field-description').text(mw.msg('cradle-new-item-identity-desc')));
            
            // Lang & Label input
            let $labelRow = $('<div>').addClass('cradle-row');
            let $langInput = $('<input>')
                .addClass('cradle-input')
                .addClass('cradle-lang-input')
                .attr('type', 'text')
                .attr('id', 'cradle-new-item-lang')
                .val(mw.config.get('wgUserLanguage') || 'en');
                
            let $labelInput = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('id', 'cradle-new-item-label')
                .attr('placeholder', mw.msg('cradle-new-item-label'));

            $labelRow.append($langInput).append($labelInput);
            $metaCard.append($labelRow);

            // Description input
            let $descInput = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('id', 'cradle-new-item-desc')
                .attr('placeholder', mw.msg('cradle-new-item-desc'));
                
            $metaCard.append($('<div>').addClass('cradle-row').append($descInput));
            $content.append($metaCard);
        }

        // Render properties
        propIds.forEach(pid => {
            let propDef = schemaProperties[pid];
            let meta = propertyMetadata[pid] || { label: pid, description: '', datatype: 'string' };
            
            let $card = $('<div>')
                .addClass('cradle-field-card')
                .attr('id', `cradle-card-${pid}`);
                
            if (propDef.mandatory) {
                $card.addClass('mandatory');
            }

            // Header of card
            let $cardHeader = $('<div>').addClass('cradle-field-header');
            let $label = $('<h3>').addClass('cradle-field-title');
            
            // Prepend validation badge span next to title
            let $badge = $('<span>').addClass('cradle-card-validation-badge').css({'margin-right': '6px', 'font-size': '1.1rem'});
            $label.append($badge);

            $label.append($('<a>').attr({
                href: `/wiki/Property:${pid}`,
                target: '_blank'
            }).text(meta.label));
            $label.append($('<span>').css({'font-size': '0.75rem', 'font-weight': 'normal', 'color': 'var(--color-subtle, #54595d)', 'margin-left': '6px'}).text(`(${pid})`));
            
            if (propDef.mandatory) {
                $label.append($('<span>').addClass('cradle-field-required-marker').text('*'));
            }
            
            $cardHeader.append($label);
            if (meta.description) {
                $cardHeader.append($('<p>').addClass('cradle-field-description').text(meta.description));
            }
            $card.append($cardHeader);

            // Container for statement input rows
            let $rowsContainer = $('<div>').attr('id', `cradle-rows-${pid}`);
            $card.append($rowsContainer);

            // Container for action bar
            let $actionsContainer = $('<div>').attr('id', `cradle-actions-${pid}`);
            $card.append($actionsContainer);

            $content.append($card);
            
            renderPropertyRows(pid);
        });

        updateDrawerFooter(true);
        liveUpdateValidation();
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
                .addClass('cradle-row')
                .attr('id', `cradle-row-${row.id}`);

            if (row.isDeleted) {
                $row.addClass('deleted');
            }

            let $inputElement = createInputForDatatype(pid, row);
            $row.append($inputElement);

            let $deleteBtn = $('<button>')
                .addClass('cradle-btn-delete')
                .html(row.isDeleted ? ICONS.undo : ICONS.trash)
                .attr('title', row.isDeleted ? 'Restore Claim' : 'Delete Claim')
                .on('click', function() {
                    toggleDeleteRow(pid, row.id);
                });

            $row.append($deleteBtn);
            $container.append($row);
        });

        // Dynamic Action Bar rendering (Add row button)
        let nonDeletedRows = rows.filter(r => !r.isDeleted);
        let maxLimit = propDef.max;
        let showAddButton = (maxLimit === '*' || maxLimit === Infinity || nonDeletedRows.length < maxLimit);

        if (showAddButton) {
            let $addBtn = $('<button>')
                .addClass('cradle-btn-text')
                .html(`${ICONS.plus} ${mw.msg('cradle-add-value')}`)
                .on('click', function() {
                    addRow(pid);
                });
            $actionsContainer.append($addBtn);
        }
    }

    /**
     * Creates appropriate jQuery inputs for a datatype.
     */
    function createInputForDatatype(pid, row) {
        let propDef = schemaProperties[pid];
        
        // 1. wikibase-item datatype
        if (row.datatype === 'wikibase-item') {
            if (propDef.softselect && propDef.softselect.length > 0) {
                let $select = $('<select>').addClass('cradle-select');
                $select.append($('<option>').val('').text('-- Select --'));
                propDef.softselect.forEach(qid => {
                    let label = softselectLabels[qid] || qid;
                    $select.append($('<option>').val(qid).text(`${label} (${qid})`));
                });
                
                $select.val(row.value);
                $select.on('change', function() {
                    row.value = $select.val();
                    liveUpdateValidation();
                });
                return $select;
            }

            let $wrapper = $('<div>').addClass('cradle-autocomplete-wrapper');
            let $input = $('<input>')
                .addClass('cradle-input')
                .attr('type', 'text')
                .attr('placeholder', mw.msg('cradle-search-placeholder'))
                .val(row.value);

            let $dropdown = $('<ul>').addClass('cradle-autocomplete-dropdown').hide();
            $wrapper.append($input).append($dropdown);

            if (row.value && row.value.startsWith('Q')) {
                loadItemLabels([row.value]).then(labels => {
                    if (labels[row.value]) {
                        $input.val(`${labels[row.value]} (${row.value})`);
                    }
                });
            }

            let searchTimeout = null;
            $input.on('input', function() {
                let query = $input.val().trim();
                
                // If they typed a valid QID directly, update row value immediately
                if (/^[qQ]\d+$/.test(query)) {
                    row.value = query.toUpperCase();
                } else {
                    row.value = '';
                }
                liveUpdateValidation();
                
                clearTimeout(searchTimeout);
                if (query.length < 2) {
                    $dropdown.hide();
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
                            let $row = $('<li>').addClass('cradle-autocomplete-row');
                            $row.append($('<span>').addClass('cradle-autocomplete-row-label').text(`${res.label} (${res.id})`));
                            if (res.description) {
                                $row.append($('<span>').addClass('cradle-autocomplete-row-desc').text(res.description));
                            }
                            
                            $row.on('click', function() {
                                row.value = res.id;
                                $input.val(`${res.label} (${res.id})`);
                                $dropdown.hide();
                                liveUpdateValidation();
                            });
                            
                            $dropdown.append($row);
                        });
                        $dropdown.show();
                    });
                }, 300);
            });

            $(document).on('click', function(e) {
                if (!$(e.target).closest($wrapper).length) {
                    $dropdown.hide();
                }
            });

            return $wrapper;
        }

        // 2. monolingualtext datatype
        if (row.datatype === 'monolingualtext') {
            let $group = $('<div>').css({'display': 'flex', 'gap': '8px', 'flex': '1'});
            let valObj = row.value || { text: '', language: 'en' };
            
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
                .val(valObj.text);

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

            $group.append($langInput).append($textInput);
            return $group;
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

        let langCode = 'en';
        let labelVal = '';
        let descVal = '';
        if (activeMode === 'create') {
            langCode = $('#cradle-new-item-lang').val().trim();
            labelVal = $('#cradle-new-item-label').val().trim();
            descVal = $('#cradle-new-item-desc').val().trim();
            
            if (!labelVal) {
                mandatoryErrors.push(mw.msg('cradle-label-required'));
            }
        }

        // Validate mandatory claims
        Object.keys(schemaProperties).forEach(pid => {
            let propDef = schemaProperties[pid];
            let rows = formState[pid];
            let meta = propertyMetadata[pid] || { label: pid };
            
            let activeClaimsCount = rows.filter(r => !r.isDeleted && !isEmptyValue(r.value, r.datatype)).length;
            
            if (propDef.mandatory && activeClaimsCount === 0) {
                mandatoryErrors.push(mw.msg('cradle-mandatory-error', meta.label, pid));
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
            let creationData = {
                labels: {
                    [langCode]: { language: langCode, value: labelVal }
                },
                claims: claimsPayload
            };
            if (descVal) {
                creationData.descriptions = {
                    [langCode]: { language: langCode, value: descVal }
                };
            }
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
        if (datatype === 'string' || datatype === 'external-id' || datatype === 'url') {
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
            let timeStr = value.trim();
            if (!timeStr.startsWith('+') && !timeStr.startsWith('-')) {
                timeStr = '+' + timeStr;
            }
            if (timeStr.length === 5) {
                timeStr += '-00-00T00:00:00Z';
            } else if (timeStr.length === 8) {
                timeStr += '-00T00:00:00Z';
            } else if (timeStr.length === 11) {
                timeStr += 'T00:00:00Z';
            }
            
            let precision = 9; // Year
            if (timeStr.includes('-00-00')) {
                precision = 9;
            } else if (timeStr.includes('-00T')) {
                precision = 10; // Month
            } else {
                precision = 11; // Day
            }

            return {
                type: 'time',
                value: {
                    time: timeStr,
                    timezone: 0,
                    before: 0,
                    after: 0,
                    precision: precision,
                    calendarmodel: 'http://www.wikidata.org/entity/Q1985727'
                }
            };
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
     * Render the Cradle Schema Designer UI.
     */
    function renderSchemaDesigner(editSchemaName, editSchemaData) {
        let $content = $('#cradle-content-area').empty();
        updateDrawerFooter(false);

        let isEdit = !!editSchemaName;
        let titleVal = isEdit ? editSchemaName : '';

        let $form = $('<div>').addClass('cradle-selector-box').css({'display': 'flex', 'flex-direction': 'column', 'gap': '12px'});
        $form.append($('<h3>').css({'margin': '0'}).text(mw.msg('cradle-schema-designer')));

        let $titleInput = $('<input>').addClass('cradle-input').attr('placeholder', mw.msg('cradle-schema-title')).val(titleVal);
        if (isEdit) {
            $titleInput.attr('disabled', 'disabled');
        }
        $form.append($('<div>')
            .append($('<label>').css({'display': 'block', 'font-weight': 'bold', 'margin-bottom': '4px'}).text(mw.msg('cradle-schema-title')))
            .append($titleInput)
        );

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

        // Helper to batch fetch labels for properties and items
        function fetchLabelsInBatches(ids, callback) {
            let labels = {};
            if (ids.length === 0) {
                callback(labels);
                return;
            }
            let api = new mw.Api();
            let chunks = [];
            for (let i = 0; i < ids.length; i += 50) {
                chunks.push(ids.slice(i, i + 50));
            }
            let pending = chunks.length;
            chunks.forEach(chunk => {
                api.get({
                    action: 'wbgetentities',
                    ids: chunk,
                    props: 'labels',
                    languages: mw.config.get('wgUserLanguage') || 'en',
                    format: 'json'
                }).done(function(res) {
                    if (res.entities) {
                        let lang = mw.config.get('wgUserLanguage') || 'en';
                        chunk.forEach(id => {
                            if (res.entities[id] && res.entities[id].labels) {
                                let lbl = res.entities[id].labels[lang] || res.entities[id].labels['en'];
                                labels[id] = lbl ? lbl.value : '';
                            }
                        });
                    }
                    pending--;
                    if (pending === 0) callback(labels);
                }).fail(function() {
                    pending--;
                    if (pending === 0) callback(labels);
                });
            });
        }

        function renderPropRow(pid, mandatory, defaultValue, hardselectQIDs, softselectQIDs, labelsMap) {
            let propLabel = labelsMap[pid] ? ` (${labelsMap[pid]})` : '';
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
            $headerRow.append($('<strong>').css({'font-size': '14px'}).text(pid + propLabel));
            let $remove = $('<button>').addClass('cradle-btn-secondary').css({'padding': '2px 6px', 'color': '#d33', 'font-weight': 'bold'}).html(ICONS.close).on('click', function() {
                $row.remove();
            });
            $headerRow.append($remove);
            $row.append($headerRow);

            // Mandatory checkbox
            let $optionsRow = $('<div>').css({'display': 'flex', 'gap': '12px', 'align-items': 'center'});
            let $reqCheck = $('<input>').attr('type', 'checkbox').attr('checked', mandatory ? 'checked' : false);
            let $reqLabel = $('<label>').css({'display': 'flex', 'align-items': 'center', 'gap': '4px', 'font-size': '13px'})
                .append($reqCheck)
                .append(mw.msg('cradle-required-checkbox'));
            $optionsRow.append($reqLabel);
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
                return {
                    pid: pid,
                    mandatory: $reqCheck.is(':checked'),
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

        let $footer = $('#cradle-footer-area').empty();
        let $saveBtn = $('<button>').addClass('cradle-btn-primary').text(mw.msg('cradle-save-schema')).on('click', function() {
            let name = $titleInput.val().trim();
            if (!name) {
                mw.notify(mw.msg('cradle-schema-title-required'), { type: 'error' });
                return;
            }
            let wikitext = '== ' + name + ' ==\n';

            let hasProps = false;
            $propsList.children().each(function() {
                let rowData = $(this).data('get_data')();
                let pid = rowData.pid;
                let mandatory = rowData.mandatory;
                let hSel = rowData.hardselect;
                let sSel = rowData.softselect;

                let parts = [];
                if (hSel) parts.push('hardselect:' + hSel);
                if (sSel) parts.push('softselect:' + sSel);
                if (mandatory) parts.push('mandatory');

                wikitext += '; ' + pid;
                if (parts.length > 0) {
                    wikitext += ' : ' + parts.join(' | ');
                }
                wikitext += '\n';
                hasProps = true;
            });

            if (!hasProps) {
                mw.notify(mw.msg('cradle-schema-prop-required'), { type: 'error' });
                return;
            }

            saveOrUpdateSchema(name, wikitext, function() {
                renderCreateOptionsSelector();
            });
        });

        let $cancelBtn = $('<button>').addClass('cradle-btn-secondary').html(ICONS.back + ' <span>' + mw.msg('cradle-back') + '</span>').on('click', function() {
            renderCreateOptionsSelector();
        });

        $footer.append($cancelBtn).append($saveBtn);
    }
    
    $(document).ready(function() {
        mw.loader.using(['mediawiki.api', 'mediawiki.util', 'mediawiki.storage', 'mediawiki.jqueryMsg']).then(init);
    });

})();

