/**
 * Cradle - A Wikidata User Gadget
 *
 * This script provides a Cradle-like form editor directly within Wikidata item pages.
 * It automatically detects EntitySchemas associated with the item's classes (via Property P12861
 * on the item itself or its P31 "instance of" / P279 "subclass of" classes), parses the ShEx schema,
 * and displays a premium, modern drawer interface to add, modify, or delete claims in-place.
 *
 * Authors: Daniel Yepez Garces, Ismael Olea
 * Based on: Cradle (https://cradle.toolforge.org/) by Magnus Manske
 * Version: 1.2.3
 *
 * Installation:
 * Add the following line to your [[Special:MyPage/common.js]] on Wikidata (increment version value to bypass cache):
 * mw.loader.load('//www.wikidata.org/w/index.php?title=User:Danielyepezgarces/Gadget-cradle.js&action=raw&ctype=text/javascript&version=1.2.3');
 */

(function() {
    'use strict';

    // Verify if we are on Wikidata
    if (!mw.config.get('wgServer').includes('wikidata.org')) {
        return;
    }

    const P12861 = 'P12861'; // EntitySchema for this class
    const P31 = 'P31';       // Instance of
    const P279 = 'P279';     // Subclass of

    let pageName = mw.config.get('wgPageName');
    let isSpecialCradle = (pageName === 'Special:Cradle' || pageName === 'Special:BlankPage/Cradle');
    let isItemPage = (mw.config.get('wgNamespaceNumber') === 0 && mw.config.get('wbEntityId'));
    let entityId = isItemPage ? mw.config.get('wbEntityId') : null;

    // State
    let entityData = null;
    let detectedSchemas = [];
    let cradleTemplates = {};
    let activeSchema = null;
    let activeTemplate = null;
    let activeMode = isItemPage ? 'edit' : 'create'; // 'edit' or 'create'

    let schemaProperties = {};
    let propertyMetadata = {};
    let softselectLabels = {};
    let formState = {}; // propertyId -> Array of { id, guid, value, datatype, isDeleted }

    // Stylesheet aligned with Wikimedia design guidelines & Vector light/dark mode
    const customCSS = `
        /* Floating Action Button (FAB) matching Wikimedia style with high contrast */
        .cradle-fab {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background-color: var(--background-color-interactive, #36c);
            color: #ffffff !important; /* Explicit white color for maximum contrast */
            border: 1px solid var(--border-color-interactive, #36c);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 9999;
            transition: background-color 0.2s, box-shadow 0.2s;
            outline: none;
        }
        .cradle-fab:hover {
            background-color: var(--background-color-interactive-hover, #447ff5);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
        }
        .cradle-fab:active {
            background-color: var(--background-color-interactive-active, #2a4b8d);
        }
        .cradle-fab svg {
            width: 20px;
            height: 20px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
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
            padding: 6px 8px;
            border-radius: 2px;
            border: 1px solid var(--border-color-base, #a2a9b1);
            background-color: var(--background-color-base, #ffffff);
            color: var(--color-base, #202122);
            font-size: 0.85rem;
            outline: none;
            transition: border-color 0.1s, box-shadow 0.1s;
            height: 32px;
        }
        .cradle-input:focus {
            border-color: var(--border-color-progressive-focus, #36c);
            box-shadow: inset 0 0 0 1px var(--border-color-progressive-focus, #36c);
        }

        .cradle-select {
            flex: 1;
            padding: 6px 8px;
            border-radius: 2px;
            border: 1px solid var(--border-color-base, #a2a9b1);
            background-color: var(--background-color-base, #ffffff);
            color: var(--color-base, #202122);
            font-size: 0.85rem;
            outline: none;
            height: 32px;
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
            padding: 16px 20px;
            border-top: 1px solid var(--border-color-base, #a2a9b1);
            display: flex;
            gap: 12px;
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
        }
        .cradle-btn-primary:hover {
            background-color: var(--background-color-interactive-hover, #447ff5);
            border-color: var(--border-color-interactive-hover, #447ff5);
        }
        .cradle-btn-primary:active {
            background-color: var(--background-color-interactive-active, #2a4b8d);
        }
        .cradle-btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .cradle-btn-secondary {
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
    `;

    // SVG Icons
    const ICONS = {
        cradle: `<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
        close: `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        plus: `<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
        trash: `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`,
        undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`
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
            'cradle-change-form': '← Change Form',
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
            'cradle-change-schema': '← Change Schema',
            'cradle-edit-summary': 'Updated statements using Cradle Wikidata Gadget (EntitySchema:$1)',
            'cradle-create-summary': 'Created new item using Cradle Wikidata Gadget (Template: $1)',
            'cradle-search-placeholder': 'Search item...',
            'cradle-credits': 'Created by $1 & $2. Based on $3 by Magnus Manske.'
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
                    'cradle-change-form': '← Cambiar formulario',
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
                    'cradle-change-schema': '← Cambiar esquema',
                    'cradle-edit-summary': 'Declaraciones actualizadas con el gadget Cradle de Wikidata (EntitySchema:$1)',
                    'cradle-create-summary': 'Nuevo elemento creado con el gadget Cradle de Wikidata (Plantilla: $1)',
                    'cradle-search-placeholder': 'Buscar elemento...',
                    'cradle-credits': 'Creado por $1 e $2. Basado en $3 por Magnus Manske.'
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
            createFAB();

            // Scan for schemas if on an item page
            loadEntityData(entityId).then(data => {
                entityData = data;
                return findAssociatedSchemas(entityData);
            }).then(schemas => {
                detectedSchemas = schemas;
                console.log("[Cradle] Detected EntitySchemas:", detectedSchemas);
            }).catch(err => {
                console.error("[Cradle] Error loading claims/schemas:", err);
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

        // Add credits linking to PU as centered footer
        let danielLink = '<a href="' + mw.util.getUrl('User:Danielyepezgarces') + '" target="_blank">Daniel Yepez Garces (dyepezg)</a>';
        let ismaelLink = '<a href="' + mw.util.getUrl('User:Olea') + '" target="_blank">Ismael Olea</a>';
        let cradleLink = '<a href="https://cradle.toolforge.org/" target="_blank">Cradle</a>';

        let $credits = $('<p>')
            .css({
                'font-size': '0.8rem',
                'color': 'var(--color-subtle, #54595d)',
                'margin-top': '20px',
                'margin-bottom': '10px',
                'text-align': 'center',
                'width': '100%'
            })
            .html(mw.msg('cradle-credits', danielLink, ismaelLink, cradleLink));

        $container.append($content).append($footer).append($credits);
        $contentArea.append($container);

        renderCreateOptionsSelector();
    }

    /**
     * Creates the Floating Action Button.
     */
    function createFAB() {
        let $fab = $('<button>')
            .addClass('cradle-fab')
            .attr('title', 'Cradle Schema Editor')
            .html(ICONS.cradle);

        $fab.on('click', openEditor);
        $('body').append($fab);
    }

    /**
     * Fetch the entity data from Wikidata Action API.
     */
    function loadEntityData(id) {
        let api = new mw.Api();
        return api.get({
            action: 'wbgetentities',
            ids: id,
            format: 'json'
        }).then(res => {
            if (res && res.entities && res.entities[id]) {
                return res.entities[id];
            }
            throw new Error("Unable to load entity data");
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

        // Query the classes to see if they have P12861
        let api = new mw.Api();
        return api.get({
            action: 'wbgetentities',
            ids: classesToCheck.join('|'),
            props: 'claims',
            format: 'json'
        }).then(res => {
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
            return schemas;
        });
    }

    /**
     * Opens the Sidebar Drawer editor.
     */
    function openEditor() {
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
        activeSchema = null;
        activeTemplate = null;

        if (activeMode === 'edit') {
            if (detectedSchemas.length > 0) {
                loadAndDisplaySchema(detectedSchemas[0]);
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
        $('#cradle-footer-area').empty();

        let $box = $('<div>').addClass('cradle-selector-box');
        $box.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-enter-schema-title')));

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
                    loadAndDisplaySchema(schemaId);
                }
            });

        let $inputGroup = $('<div>').css({'display': 'flex', 'gap': '8px', 'margin-top': '8px'});
        $inputGroup.append($manualInput).append($loadBtn);
        $box.append($inputGroup);
        $content.append($box);
    }

    /**
     * Renders selection panel for Create mode (Template or Schema).
     */
    function renderCreateOptionsSelector() {
        let $content = $('#cradle-content-area').empty();
        $('#cradle-footer-area').empty();

        $content.append($('<div>').css({'text-align': 'center', 'margin-top': '20px'})
            .append($('<div>').addClass('cradle-spinner').css({'border-top-color': 'var(--border-color-progressive, #36c)'}))
            .append($('<p>').text(mw.msg('cradle-loading-templates')))
        );

        // Fetch Wikidata:Cradle forms list
        loadCradleWikitext().then(wikitext => {
            cradleTemplates = parseCradleWikitext(wikitext);

            $content.empty();
            let $box = $('<div>').addClass('cradle-selector-box');
            $box.append($('<p>').css({'margin-top': '0', 'font-weight': 'bold'}).text(mw.msg('cradle-method-predefined')));

            let $select = $('<select>').addClass('cradle-select');
            $select.append($('<option>').val('').text(mw.msg('cradle-select-predefined')));

            // Sort keys alphabetically
            Object.keys(cradleTemplates).sort().forEach(key => {
                let t = cradleTemplates[key];
                let label = t.labels[mw.config.get('wgUserLanguage')] || t.title;
                $select.append($('<option>').val(key).text(label));
            });
            $box.append($select);
            $content.append($box);

            // Event on selecting predefined form
            $select.on('change', function() {
                let key = $select.val();
                if (key) {
                    loadAndDisplayTemplate(key);
                }
            });

            // Method 2: EntitySchema
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
            $group.append($schemaInput).append($schemaBtn);
            $boxSchema.append($group);
            $content.append($boxSchema);

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
        $('#cradle-footer-area').empty();

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

        Promise.all([
            loadPropertiesMetadata(propIds),
            loadItemLabels(softselectQids)
        ]).then(results => {
            propertyMetadata = results[0];
            softselectLabels = results[1];

            // Map cradle format to parser properties
            schemaProperties = {};
            propIds.forEach(pid => {
                let pDef = t.props[pid];
                schemaProperties[pid] = {
                    id: pid,
                    min: pDef.mandatory ? 1 : 0,
                    max: pDef.hardselect.length > 0 ? 1 : Infinity,
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
     * Loads the EntitySchema page content, parses it, fetches metadata and renders the form.
     */
    function loadAndDisplaySchema(schemaId) {
        let $content = $('#cradle-content-area').empty();
        $content.append($('<div>').css({'text-align': 'center', 'margin-top': '40px'})
            .append($('<div>').addClass('cradle-spinner').css({'border-top-color': 'var(--border-color-progressive, #36c)', 'width': '30px', 'height': '30px'}))
            .append($('<p>').text(mw.msg('cradle-loading-schema', schemaId)))
        );
        $('#cradle-footer-area').empty();

        fetchSchema(schemaId).then(schema => {
            activeSchema = schema;
            if (!isSpecialCradle) {
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
        let api = new mw.Api();
        let userLang = mw.config.get('wgUserLanguage') || 'en';
        return api.get({
            action: 'wbgetentities',
            ids: propIds.join('|'),
            props: 'info|labels|descriptions|datatype',
            languages: userLang + '|en',
            format: 'json'
        }).then(res => {
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
                    if (ent.descriptions) {
                        desc = (ent.descriptions[userLang] && ent.descriptions[userLang].value) ||
                               (ent.descriptions['en'] && ent.descriptions['en'].value) ||
                               "";
                    }
                    metadata[pid] = {
                        id: pid,
                        label: label,
                        description: desc,
                        datatype: ent.datatype
                    };
                });
            }
            return metadata;
        });
    }

    /**
     * Fetch labels for specific QIDs.
     */
    function loadItemLabels(qids) {
        if (qids.length === 0) return Promise.resolve({});

        // Remove duplicates
        qids = [...new Set(qids)];

        let api = new mw.Api();
        let userLang = mw.config.get('wgUserLanguage') || 'en';
        return api.get({
            action: 'wbgetentities',
            ids: qids.join('|'),
            props: 'labels',
            languages: userLang + '|en',
            format: 'json'
        }).then(res => {
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
            return labels;
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

            // Map existing claims on the entity (if in edit mode)
            if (activeMode === 'edit' && entityData && entityData.claims && entityData.claims[pid]) {
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
     * Renders the complete form fields.
     */
    function renderForm() {
        let $content = $('#cradle-content-area').empty();
        let propIds = Object.keys(schemaProperties);

        // Render back button
        let $headerPanel = $('<div>').css({'display': 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '16px'});
        $headerPanel.append($('<button>').addClass('cradle-btn-secondary').text(mw.msg('cradle-change-form')).on('click', renderActiveView));
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

            // Action bar (Add row button)
            if (propDef.max > 1) {
                let $actions = $('<div>').addClass('cradle-card-action-bar');
                let $addBtn = $('<button>')
                    .addClass('cradle-btn-text')
                    .html(`${ICONS.plus} ${mw.msg('cradle-add-value')}`)
                    .on('click', function() {
                        addRow(pid);
                    });
                $actions.append($addBtn);
                $card.append($actions);
            }

            $content.append($card);

            renderPropertyRows(pid);
        });

        // Render Footer Save/Cancel buttons
        let $footer = $('#cradle-footer-area').empty();
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

        $footer.append($cancelBtn).append($saveBtn);
    }

    /**
     * Render statement rows for a given property.
     */
    function renderPropertyRows(pid) {
        let $container = $(`#cradle-rows-${pid}`).empty();
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
            });
            $textInput.on('input', function() {
                valObj.text = $textInput.val();
                row.value = valObj;
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
    }

    /**
     * Search wikidata items.
     */
    function searchWikidataItems(term) {
        let api = new mw.Api();
        return api.get({
            action: 'wbsearchentities',
            search: term,
            language: mw.config.get('wgUserLanguage') || 'en',
            type: 'item',
            format: 'json'
        }).then(res => {
            return res.search || [];
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

        if (mandatoryErrors.length > 0) {
            alert(mw.msg('cradle-validation-error') + mandatoryErrors.join('\n'));
            return;
        }

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
            alert(mw.msg('cradle-no-changes'));
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
            console.error("[Cradle] Save error:", code, err);
            let errMsg = err && err.error && err.error.info ? err.error.info : code;
            alert(mw.msg('cradle-save-error', errMsg));
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
    $(document).ready(function() {
        mw.loader.using(['mediawiki.api', 'mediawiki.util', 'mediawiki.storage', 'mediawiki.jqueryMsg']).then(init);
    });

})();
