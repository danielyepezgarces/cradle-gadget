<?php
namespace MediaWiki\Extension\CradleWikibase;

use SpecialPage;

class SpecialCradleReport extends SpecialPage {
    public function __construct() {
        parent::__construct( 'CradleReport' );
    }

    /**
     * Executes the special page view
     */
    public function execute( $subPage ) {
        $out = $this->getOutput();
        
        // Set document title
        $out->setPageTitle( $this->msg( 'cradlewikibase-report-title' ) );

        // Add client ResourceLoader script and styles module
        $out->addModules( [ 'ext.cradleWikibase' ] );

        // Append root div container
        $html = '<div id="cradle-report-root" class="cradle-report-container-native"></div>';
        $out->addHTML( $html );
    }
}
