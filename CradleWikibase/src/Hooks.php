<?php
namespace MediaWiki\Extension\CradleWikibase;

use OutputPage;
use Skin;

class Hooks {
    /**
     * Injects the Cradle script and styles globally into MediaWiki
     */
    public static function onBeforePageDisplay( OutputPage $out, Skin $skin ): void {
        $out->addModules( [ 'ext.cradleWikibase' ] );
    }
}
