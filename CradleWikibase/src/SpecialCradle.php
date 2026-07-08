<?php
namespace MediaWiki\Extension\CradleWikibase;

use SpecialPage;

class SpecialCradle extends SpecialPage {
    public function __construct() {
        parent::__construct( 'Cradle' );
    }

    /**
     * Executes the special page view
     */
    public function execute( $subPage ) {
        $out = $this->getOutput();
        
        // Set document title
        $out->setPageTitle( $this->msg( 'cradlewikibase-cradle-title' ) );

        // Add client ResourceLoader script and styles module
        $out->addModules( [ 'ext.cradleWikibase' ] );

        // Append root div container
        $html = '<div id="cradle-root" class="cradle-container-native"></div>';
        $out->addHTML( $html );
    }
}
