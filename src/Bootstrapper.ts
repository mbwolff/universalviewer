import BootstrapParams = require("BootstrapParams");
import BaseExtension = require("./modules/uv-shared-module/BaseExtension");

class Bootstrapper{

    config: any;
    configExtension: any;
    extension: BaseExtension;
    extensions: any;
    isFullScreen: boolean = false; // persist full screen between reloads
    manifest: any;
    params: BootstrapParams;
    sequence: any;
    sequenceIndex: number;
    sequences: any;
    socket: any; // maintain the same socket between reloads

    // this loads the manifest, determines what kind of extension and provider to use, and instantiates them.
    constructor(extensions: any) {
        this.extensions = extensions;
    }

    getBootstrapParams(): BootstrapParams {
        var p = new BootstrapParams();
        var jsonpParam = Utils.Urls.GetQuerystringParameter('jsonp');

        p.config = Utils.Urls.GetQuerystringParameter('config');
        p.domain = Utils.Urls.GetQuerystringParameter('domain');
        p.embedDomain = Utils.Urls.GetQuerystringParameter('embedDomain');
        p.embedScriptUri = Utils.Urls.GetQuerystringParameter('embedScriptUri');
        p.isHomeDomain = Utils.Urls.GetQuerystringParameter('isHomeDomain') === "true";
        p.isLightbox = Utils.Urls.GetQuerystringParameter('isLightbox') === "true";
        p.isOnlyInstance = Utils.Urls.GetQuerystringParameter('isOnlyInstance') === "true";
        p.isReload = Utils.Urls.GetQuerystringParameter('isReload') === "true";
        p.jsonp = jsonpParam === null ? null : !(jsonpParam === "false" || jsonpParam === "0");
        p.manifestUri = Utils.Urls.GetQuerystringParameter('manifestUri');
        p.setLocale(Utils.Urls.GetQuerystringParameter('locale'));

        return p;
    }

    bootStrap(params?: BootstrapParams): void {
        var that = this;

        that.params = this.getBootstrapParams();

        // merge new params
        if (params){
            that.params = $.extend(true, that.params, params);
        }

        // empty app div
        $('#app').empty();

        //// add loading class
        //$('#app').addClass('loading');

        // remove any existing css
        $('link[type*="text/css"]').remove();

        jQuery.support.cors = true;

        // if data-config has been set on embedding div, load the js
        if (that.params.config){

            // if "sessionstorage"
            if (that.params.config.toLowerCase() === "sessionstorage"){
                var config = sessionStorage.getItem("uv-config-" + that.params.localeName);
                that.configExtension = JSON.parse(config);
                that.loadManifest();
            } else {
                $.getJSON(that.params.config, (configExtension) => {
                    that.configExtension = configExtension;
                    that.loadManifest();
                });
            }
        } else {
            that.loadManifest();
        }
    }

    corsEnabled(): boolean {
        // No jsonp setting? Then use autodetection. Otherwise, use explicit setting.
        return (null === this.params.jsonp) ? Modernizr.cors : !this.params.jsonp;
    }

    loadManifest(): void{
        var that = this;

        if (this.corsEnabled()){
            //console.log('CORS Enabled');
            $.getJSON(that.params.manifestUri, (manifest) => {
                that.parseManifest(manifest);
            });
        } else {
            //console.log('JSONP Enabled');
            // use jsonp
            var settings: JQueryAjaxSettings = <JQueryAjaxSettings>{
                url: that.params.manifestUri,
                type: 'GET',
                dataType: 'jsonp',
                jsonp: 'callback',
                jsonpCallback: 'manifestCallback'
            };

            $.ajax(settings);

            window.manifestCallback = (manifest: any) => {
                that.parseManifest(manifest);
            };
        }
    }

    parseManifest(manifest: any): void {
        this.manifest = manifest;

        if (this.params.isHomeDomain && !this.params.isReload) {
            this.sequenceIndex = parseInt(Utils.Urls.GetHashParameter("si", parent.document));
        }

        if (!this.sequenceIndex) {
            this.sequenceIndex = parseInt(Utils.Urls.GetQuerystringParameter("si")) || 0;
        }

        // is it a collection?
        if (this.manifest.manifests){
            // for now, default to the first manifest in the collection.
            // todo: improve collections handling - should a new "mi" param be introduced?
            this.params.manifestUri = this.manifest.manifests[0].service['@id'];
            this.loadManifest();
            return;
        }

        if (this.manifest.xsequences){
            this.manifest.sequences = this.manifest.xsequences;
        }

        this.sequences = this.manifest.sequences;

        if (!this.sequences) {
            this.notFound();
        }

        this.loadSequence();
    }

    loadSequence(): void{

        var that = this;

        // if it's not a reference, load dependencies
        if (that.sequences[that.sequenceIndex].canvases) {
            that.sequence = that.sequences[that.sequenceIndex];
            that.loadDependencies();
        } else {
            // load referenced sequence.
            var sequenceUri = String(that.sequences[that.sequenceIndex]['@id']);

            $.getJSON(sequenceUri, (sequenceData) => {
                that.sequence = that.sequences[that.sequenceIndex] = sequenceData;
                that.loadDependencies();
            });
        }
    }

    notFound(): void{
        try{
            parent.$(parent.document).trigger("onNotFound");
            return;
        } catch (e) {}
    }

    loadDependencies(): void {

        var that = this;
        var extension;

        // look at the first canvas type in the sequence and use that
        // to establish which extension to use.
        // todo: should viewinghint="time-based" be added to the manifest/sequence?
        // The UV should probably be able to load different extensions on a per-canvas-basis.

        var canvasType = that.sequence.canvases[0]['@type'];

        switch(canvasType.toLowerCase()) {
            case 'sc:canvas':
                extension = that.extensions['seadragon/iiif'];
                break;
            case 'ixif:audio':
                extension = that.extensions['audio/iiif'];
                break;
            case 'ixif:video':
                extension = that.extensions['video/iiif'];
                break;
            case 'ixif:borndigital':
                extension = that.extensions['pdf/iiif'];
                break;
        }

        // todo: use a compiler flag when available
        var configPath = (window.DEBUG)? 'extensions/' + extension.name + '/build/' + that.params.getLocaleName() + '.config.json' : 'lib/' + extension.name + '.' + that.params.getLocaleName() + '.config.json';

        // feature detection
        yepnope({
            test: window.btoa && window.atob,
            nope: 'lib/base64.min.js',
            complete: function () {
                $.getJSON(configPath, (config) => {

                    config.name = extension.name;

                    // if data-config has been set on embedding div, extend the existing config object.
                    if (that.configExtension){
                        // save a reference to the config extension uri.
                        config.uri = that.params.config;

                        $.extend(true, config, that.configExtension);
                    }

                    // todo: use a compiler flag when available
                    var cssPath = (window.DEBUG)? 'extensions/' + extension.name + '/build/' + config.options.theme + '.css' : 'themes/' + config.options.theme + '/css/' + extension.name + '/theme.css';

                    yepnope.injectCss(cssPath, function () {
                        that.createExtension(extension, config);
                    });
                });
            }
        });
    }

    createExtension(extension: any, config: any): void{

        this.config = config;

        var provider = new extension.provider(this);
        provider.load();

        this.extension = new extension.type(this);
        this.extension.name = extension.name;
        this.extension.provider = provider;
        this.extension.create();
    }
}

export = Bootstrapper;