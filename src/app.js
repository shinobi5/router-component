'use strict';
var Promise = require('promise');
var path = require('path');
var Listen = require('listen-js');
var Handlebars = require('handlebars');
var slugify = require('handlebars-helper-slugify');
var _ = require('underscore');
var Page = require('./page');
var Module = require('module-js');
var ElementKit = require('element-kit');

/**
 * The function that is triggered the selected dropdown value changes
 * @callback App~onRouteRequest
 * @param {string} input - The url that was a requested
 * @returns {Promise} Returns a promise that resolves with a path string of the route to go to when done
 */

/**
 * App class.
 * @description Represents a manager that handles all routes throughout the app.
 * @class App
 * @return {App} Returns a singleton instance of app
 */
var App = function (options){
    this.initialize(options);
    return this;
};

App.prototype = /** @lends App */{

    /**
     * Initialize options
     * @param {Object} [options] - The options object
     * @param {Object} [options.pagesConfig] - An object mapping of all pages along with their associated urls
     * @param {HTMLElement} [options.pagesContainer] - The element to use for the page container (defaults to document.body)
     * @param {Object} [options.moduleConfig] - An object mapping of all available modules
     * @param {Function} [options.onRouteRequest] - Called whenever a route is requested (can be used to intercept requests)
     */
    initialize: function (options) {

        this.options = _.extend({
            onRouteRequest: null,
            pagesContainer: document.body,
            pagesConfig: {},
            modulesConfig: {}
        }, options);

        this._pageMaps = {};
        this._globalModuleMaps = {};
        this.history = [];

        // convert page keys into array to preserve order for later use
        this._pageKeys = _.keys(this.options.pagesConfig);

        // setup helpers
        Handlebars.registerHelper('slugify', slugify);

    },

    /**
     * Starts managing routes.
     */
    start: function () {
        Listen.createTarget(this);
        this._globalModuleMaps = this._buildGlobalModuleMaps();
        this.bindPopstateEvent();
    },

    /**
     * Stops routing urls.
     */
    stop: function () {
        this.reset();
        this.unbindPopstateEvent();
        Listen.destroyTarget(this);
    },

    /**
     * Sets up pop state events for future urls.
     */
    bindPopstateEvent: function () {
        window.addEventListener('popstate', this._getOnPopStateListener());
    },

    /**
     * Removes pop state event listener.
     */
    unbindPopstateEvent: function () {
        window.removeEventListener('popstate', this._getOnPopStateListener());
    },

    /**
     * Gets the cached listener for pop state changes.
     * @returns {Function}
     * @private
     */
    _getOnPopStateListener: function () {
        var self = this;
        return function (event) {
            // sometimes ios browser doesnt have a event state object on initial load *shrug*
            if (event.state) {
                self._onRouteRequest.call(self, event.state.path);
            }
        }
    },

    /**
     * Resets Route Manager.
     */
    reset: function () {
        this.history = [];

        // destroy all pages
        _.each(this._pageMaps, function (pageMap) {
            pageMap.page.destroy();
            if (this.options.pagesContainer.contains(pageMap.el)) {
                this.options.pagesContainer.removeChild(pageMap.el);
            }
            _.each(pageMap.modules, function (moduleMap) {
                moduleMap.module.destroy();
            });
        }.bind(this));
        this._pageMaps = {};

        // destroy all global modules
        _.each(this._globalModuleMaps, function (globalMap) {
            // conditionally in case a global module config exist but hasnt been loaded
            if (globalMap.module) {
                globalMap.module.hide().then(function () {
                    globalMap.module.destroy();
                });
            }
        });
        this._globalModuleMaps = this._buildGlobalModuleMaps();
    },

    /**
     * Navigates to a supplied url.
     * @param {string} url - The url to navigate to.
     * @param {Object} [options] - Set of navigation options
     * @param {boolean} [options.trigger] - True if the route function should be called (defaults to true)
     * @param {boolean} [options.replace] - True to update the URL without creating an entry in the browser's history
     * @param {boolean} [options.triggerUrlChange] - False to not trigger the browser url to change
     * @returns {Promise} Returns a Promise when the page of the route has loaded
     */
    triggerRoute: function (url, options) {
        options = options || {};
        options.triggerUrlChange = typeof options.triggerUrlChange !== 'undefined' ? options.triggerUrlChange : true;
        if (url !== this._currentPath) {
            return this._onRouteRequest(url, options);
        } else {
            return Promise.resolve();
        }
    },

    /**
     * Gets query string params.
     * @param {string} url - The full url to navigate to.
     * @returns {Object} Returns an object containing query params.
     */
    getQueryParams: function (url) {
        var url = url || this.getWindow().location.href,
            params = {};
        url.split('?')[1].split('&').forEach(function(queryParam) {
            var splitParam = queryParam.split('=');
            params[splitParam[0]] = splitParam[1];
        });
        return params;
    },

    /**
     * Navigates to previous url in session history.
     * @param {Number} index - an index with a position relative to the current page (the current page being, of course, index 0)
     */
    goBack: function (index) {
        if (index) {
            window.history.go(index);
        } else {
            window.history.back();
        }
    },

    /**
     * Navigates forward (if gone back).
     * @param {Number} index - an index with a position relative to the current page
     */
    goForward: function (index) {
        if (index) {
            window.history.go(index);
        } else {
            window.history.forward();
        }
    },

    /**
     * Gets the current relative params.
     * @returns {Array} Returns an array of params
     */
    getRelativeUrlParams: function () {
        return this.getRelativeUrl().split('/') || [];
    },

    /**
     * Gets the current relative url.
     * @returns {string} Returns a url string
     */
    getRelativeUrl: function () {
        var url = this._currentPath || this.getWindow().location.hash.replace('#', '');
        // remove leading slash if there is one
        url = url.replace(/^\//g, '');
        return url;
    },

    /**
     * When a route is requested.
     * @param {string} path - The path that is
     * @param {Object} [options] - request options
     * @private
     * @return {Promise}
     */
    _onRouteRequest: function (path, options) {
        var prevPath = this._currentPath;
        if (path !== prevPath) {
            return this._handleRequestedUrl(path, options).then(function (path) {
                this._currentPreviousPageHidePromise = this.hidePage(prevPath);
                return this._currentPreviousPageHidePromise.then(function () {
                    return this.loadPage(path)
                        .then(function () {
                            this.dispatchEvent('page:load');
                            return this.showPage(path);
                        }.bind(this), function (e) {
                            console.log('App Error: Page could not be loaded');
                            if (e.detail) {
                                console.log(e.detail.stack);
                            } else {
                                console.log(arguments);
                            }
                            this.dispatchEvent('page:error', e);
                            throw e;
                        }.bind(this));
                }.bind(this));
            }.bind(this));
        } else {
            // already at url!
            return Promise.resolve();
        }
    },

    /**
     * Sets a url has active and adds it to the history.
     * @param {string} path - The url to set
     * @param {Object} options - Set of options
     * @param {Object} options.triggerUrlChange - Whether to trigger a url change
     */
    registerUrl: function (path, options) {
        var window = this.getWindow(),
            windowHistory = window.history;

        options = options || {};
        options.triggerUrlChange = typeof options.triggerUrlChange !== 'undefined' ? options.triggerUrlChange : true;

        if (options.triggerUrlChange) {
            // register new url in history
            windowHistory.pushState({path: path}, document.title, path);
            // push to internal history for tracking
            this.history.push(windowHistory.state);
            this._currentPath = path;
            this.dispatchEvent('url:change', {url: path});
        }

    },

    /**
     * Returns windows object.
     * @returns {History}
     */
    getWindow: function () {
        return window;
    },

    /**
     * A function that allows custom redirects of routes if necessary.
     * This method is called every time a route request is made.
     * @param {string} path - The url path that was requested
     * @param {Object} [options] - The request options
     * @returns {Promise} Returns a promise that resolves with a path to go to when done
     * @private
     */
    _handleRequestedUrl: function (path, options) {
        var getRedirectedUrl = this.options.onRouteRequest ? this.options.onRouteRequest(path) : Promise.resolve(path);

        // register attempted url
        this.registerUrl(path, options);

        //convert to promise if not already
        if (!getRedirectedUrl.then) {
            getRedirectedUrl = Promise.resolve(getRedirectedUrl);
        }
        return getRedirectedUrl.then(function (newPath) {
            // if path has changed, register old one into history
            if (newPath !== path) {
                this.registerUrl(newPath);
            }
            return newPath;
        }.bind(this));
    },

    /**
     * Gets the page config object for a supplied path.
     * @param {string} path - The path of the page
     * @returns {Object}
     */
    getPageConfigByPath: function (path) {
        var pageKey = this._getRouteMapKeyByPath(path);
        return this.options.pagesConfig[pageKey] || {};
    },

    /**
     * Gets the config object for module.
     * @param {string} key - The module key
     * @returns {Object}
     */
    getModuleConfig: function (key) {
        return this.options.modulesConfig[key] || {};
    },

    /**
     * Sanitizes a path to match to the correct item in the route config.
     * @param path
     * @returns {string}
     * @private
     */
    _getRouteMapKeyByPath: function (path) {
        var matchingKeys,
            regex;

        if (!path && typeof path !== 'string') {
            return null;
        }
        path = path.replace(/^\//g, ''); // remove leading slash!

        matchingKeys = this._pageKeys.filter(function (key) {
            regex = new RegExp(key, 'gi');
            return key === path || path.match(regex);
        });
        return matchingKeys[0];
    },

    /**
     * Loads the script for a module and falls back to internal Module class if not found.
     * @param scriptUrl - Url to script
     * @returns {*}
     */
    loadPageScript: function (scriptUrl) {
        var options = {pagesContainer: this.options.pagesContainer};
        if (!scriptUrl) {
            return Promise.resolve(new Page(options));
        }
        return this.loadScript(scriptUrl)
            .then(null, function () {
                return Promise.resolve(new Page(options));
            });
    },

    /**
     * Loads a page.
     * @param {string} path - The url of the page to load
     * @returns {*}
     */
    loadPage: function (path) {
        var pageKey = this._getRouteMapKeyByPath(path),
            pageConfig = this.options.pagesConfig[pageKey],
            pageMap = {},
            e;

        if (!pageConfig) {
            // no page configured!
            e = new Error('App Error: No routes configuration for ' + this.getRelativeUrl());
            console.error(e);
            return Promise.reject(e);
        }

        if (!this._pageMaps[pageKey]) {
            this._pageMaps[pageKey] = pageMap;
            pageMap.config = pageConfig;
            pageMap.promise = this.loadGlobalModules(path).then(function () {
                return this.loadPageScript(pageConfig.script)
                    .then(function (page) {
                        pageMap.page = page;
                        return page.getStyles(pageConfig.styles).then(function () {
                            return page.getTemplate(pageConfig.template).then(function (html) {
                                return page.fetchData(pageConfig.data, {cache: true}).then(function (data) {
                                    html = html || '';
                                    if (data) {
                                        html = Handlebars.compile(html)(data);
                                    }
                                    pageMap.data = data;
                                    pageMap.el = ElementKit.utils.createHtmlElement('<div>' + html + '</div>');
                                    this.options.pagesContainer.appendChild(pageMap.el);
                                    return this.loadPageModules(path).then(function () {
                                        return page.load({data: data, el: pageMap.el});
                                    });
                                }.bind(this));
                            }.bind(this));
                        }.bind(this));
                    }.bind(this));
            }.bind(this), function () {
                // if page loading happens to cause an error, remove
                // item from page cache to force a hard
                // reload next time a request is made to this page
                delete this._pageMaps[pageKey];
            }.bind(this));
        }
        return this._pageMaps[pageKey].promise;

    },

    /**
     * Shows modules assigned to a supplied page path.
     * @param {string} path - The page url
     * @returns {Promise} Returns a promise when all modules are done showing
     */
    showPageModules: function (path) {
        var pageKey = this._getRouteMapKeyByPath(path),
            pageMap = this._pageMaps[pageKey] || {};
        _.each(pageMap.modules, function (moduleMap) {
            moduleMap.module.show();
        });
        return this.showGlobalModules(path);
    },

    /**
     * Shows all global modules assigned to a page.
     * @param {string} path - The page path
     * @returns {Promise} Returns a promise when all global modules are shown
     */
    showGlobalModules: function (path) {
        var pageConfig = this.getPageConfigByPath(path),
            promises = [];

        pageConfig.modules = pageConfig.modules || [];

        _.each(this._globalModuleMaps, function (map, moduleKey) {
            if (pageConfig.modules.indexOf(moduleKey) !== -1) {
                // if there are matching global modules,
                // we dont want to show modules before previous page hides them
                // wait until previous page is done hiding
                promises.push(this._currentPreviousPageHidePromise.then(function () {
                    return map.module.show();
                }));
            }
        }.bind(this));

        return Promise.all(promises);
    },

    /**
     * Shows the page and its designated modules of the supplied url path.
     * @param {string} path - The url path of the page to show
     * @returns {*}
     */
    showPage: function (path) {
        var pageKey = this._getRouteMapKeyByPath(path),
            pageMap = this._pageMaps[pageKey] || {};
        this.showPageModules(path);
        if (pageMap.page) {
            return pageMap.page.show();
        }
    },

    /**
     * Hides all global modules assigned to designated path.
     * @returns {*}
     */
    hideGlobalModules: function (path) {
        var pageConfig = this.getPageConfigByPath(path),
            promises = [];

        pageConfig.modules = pageConfig.modules || [];

        _.each(this._globalModuleMaps, function (map, moduleKey) {
            if (pageConfig.modules.indexOf(moduleKey) !== -1) {
                // page has this global module specified!
                promises.push(map.promise.then(function () {
                    return map.module.hide();
                }));
            }
        }.bind(this));

        return Promise.all(promises);
    },

    /**
     * Hides a page along with its designated modules.
     * @param {string} path - The path of the page
     * @returns {Promise} Returns promise when page is done hiding.
     */
    hidePage: function (path) {
        var pageMap = this._pageMaps[this._getRouteMapKeyByPath(path)];
        if (pageMap && pageMap.promise) {
            return pageMap.promise
                .then(function () {
                    return pageMap.page.hide().then(function () {
                        return this.hidePageModules(path).then(function () {
                            return this.hideGlobalModules(path);
                        }.bind(this));
                    }.bind(this));
                }.bind(this))
                .catch(function () {
                    // if previous page load caused an error,
                    // lets still ignore and just resolve because by
                    // this time we're loading a new page
                    // and no longer care about previous page
                    return Promise.resolve();
                });
        } else {
            return Promise.resolve();
        }
    },

    /**
     * Hides all of a pages modules.
     * @param {string} path - The page of the page to hide
     * @return {Promise} Returns a promise when complete
     */
    hidePageModules: function (path) {
        var promises = [];
        var pageKey = this._getRouteMapKeyByPath(path),
            pageMap = this._pageMaps[pageKey] || {};
        _.each(pageMap.modules, function (moduleMap) {
            promises.push(moduleMap.module.hide());
        });
        return Promise.all(promises);
    },

    /**
     * Loads the modules of a page.
     * @param {string} path - The path to the page which contains the modules to be loaded
     */
    loadPageModules: function (path) {
        var pageKey = this._getRouteMapKeyByPath(path),
            config = this.getPageConfigByPath(path),
            pageMap = this._pageMaps[pageKey] || {},
            promises = [],
            loadPromise,
            pageModuleKeys = [],
            moduleMap;

        config.modules = config.modules || [];
        pageMap.modules = pageMap.modules || {};

        config.modules.forEach(function (moduleKey) {
            // only handle modules which are not global
            if (!this._globalModuleMaps[moduleKey]) {
                pageModuleKeys.push(moduleKey); //we must keep track of the order of the modules
                loadPromise = this.loadPageModule(moduleKey, pageMap.data).then(function (moduleMap) {
                    pageMap.modules[moduleKey] = moduleMap;
                });
            }
            promises.push(loadPromise);
        }.bind(this));

        return Promise.all(promises).then(function () {
            // append module elements to DOM
            // and use document frag for performance, yay!
            var frag = document.createDocumentFragment();
            _.each(pageModuleKeys, function (moduleKey) {
                moduleMap = pageMap.modules[moduleKey];
                if (!moduleMap.el) {
                    return;
                } else if (moduleMap.module.appendEl) {
                    // use custom appending method if module specifies it,
                    moduleMap.module.appendEl(moduleMap.el);
                } else {
                    // add to module frag to be appended to page container
                    frag.appendChild(moduleMap.el);
                }
            });

            if (!pageMap.el) {
                return false;
            } else {
                pageMap.el.appendChild(frag);
            }
        });
    },

    /**
     * Handles either showing or hiding global modules based on the supplied path.
     * @param {string} path - The page path
     * @returns {Promise} Returns a promise that resolves when global modules are shown and hidden
     */
    loadGlobalModules: function (path) {
        var pageConfig = this.getPageConfigByPath(path),
            promises = [];

        pageConfig.modules = pageConfig.modules || [];

        _.each(this._globalModuleMaps, function (map, moduleKey) {
            if (pageConfig.modules.indexOf(moduleKey) !== -1) {
                // page has this global module specified!
                promises.push(this.loadGlobalModule(moduleKey));
            }
        }.bind(this));

        return Promise.all(promises);
    },

    /**
     * Loads a single module for a page.
     * @param {string} moduleKey - The key of which module to load
     * @param {Object} [fallbackData] - Any fallback data to be used inside the module's template
     */
    loadPageModule: function (moduleKey, fallbackData) {
        var config = this.getModuleConfig(moduleKey),
            moduleMap = {};

        moduleMap = {};

        moduleMap.promise = this.loadModuleScript(config.script, config.options).then(function (module) {
            moduleMap.module = module;
            return module.getStyles(config.styles)
                .then(function () {
                    return module.getTemplate(config.template).then(function (html) {
                        return module.fetchData(config.data, {cache: true}).then(function (data) {
                            // use page data as fallback
                            data = _.extend({}, fallbackData, data);
                            html = html ? Handlebars.compile(html)(data): '';
                            var div = document.createElement('div');
                            div.innerHTML = html;
                            // create html into DOM element and pass it off to load call for
                            // custom mangling before it gets appended to DOM
                            moduleMap.el = div.children[0];
                            moduleMap.html = html;
                            return module.load({el: moduleMap.el, data: data}).then(function () {
                                return moduleMap;
                            });
                        }.bind(this));
                    }.bind(this));
                }.bind(this), function (e) {
                    moduleMap.module.error(e);
                    return moduleMap;
                });
        }.bind(this));
        return moduleMap.promise;
    },

    /**
     * Loads a global module based on the supplied module key.
     * @param {string} moduleKey - The module key
     * @return {Promise} Returns a promise that resolves when the module is loaded
     */
    loadGlobalModule: function (moduleKey) {
        var map = this._globalModuleMaps[moduleKey] || {},
            config = this.getModuleConfig(moduleKey);
        if (!map.promise) {
            map.promise = this.loadModuleScript(config.script).then(function (module) {
                    return module.getStyles(config.styles).then(function () {
                        return module.getTemplate(config.template).then(function (html) {
                            return module.fetchData(config.data, {cache: true}).then(function (data) {
                                html = html ? Handlebars.compile(html)(data || {}): '';
                                // inject modules into page DOM
                                var div = document.createElement('div');
                                div.innerHTML = html;
                                map.el = div.children[0];
                                // create html into DOM element and pass it off to load call for
                                // custom mangling before it gets appended to DOM
                                map.module = module;
                                return module.load({data: data, el: map.el}).catch(function (e) {
                                    // error loading global module!
                                    map.module.error(e);
                                    throw e;
                                });
                            }.bind(this));
                        }.bind(this));
                    }.bind(this));
                }.bind(this));
        }
        return map.promise;
    },

    /**
     * Builds and returns a filtered mapping of configs for all modules that are global.
     * @returns {Object}
     * @private
     */
    _buildGlobalModuleMaps: function () {
        var configs = {};
        _.each(this.options.modulesConfig, function (config, key) {
            if (config.global) {
                configs[key] = {config: config}
            }
        });
        return configs;
    },

    /**
     * Require()s a script and instantiates it if a non-singleton.
     * @param scriptUrl - Url to script
     * @param [options] - Options to pass to scripts instantiation (if not a singleton of course)
     * @returns {*} Returns the script contents if found (usually a singleton or class) or rejects if not found
     */
    loadScript: function (scriptUrl, options) {
        var contents;
        return new Promise(function (resolve, reject) {
            if (!scriptUrl) {
                return reject();
            }
            try {
                contents = require(scriptUrl);
            } catch (e) {
                console.error(e);
                reject(e);
            }
            options = options || {};

            // if function, assume it has a constructor and instantiate it
            if (typeof contents === 'function') {
                contents = new contents(options);
            }
            resolve(contents);
        }.bind(this));

    },

    /**
     * Loads the script for a module and falls back to internal Module class if not found.
     * @param scriptUrl - Url to script
     * @param [options] - Options to pass to scripts instantiation (if not a singleton of course)
     * @returns {*}
     */
    loadModuleScript: function (scriptUrl, options) {
        return this.loadScript(scriptUrl, options)
            .then(null, function () {
                // not found, so fallback to internal module class
                return Promise.resolve(new Module(options));
            });
    }

};

module.exports = App;