/* global App */
var PROXY_URL = process.env.plugins.proxy.url;

/**
 * Augment the ajax middleware with proxy urls when we make requests to a
 * recognised API endpoint.
 *
 * @param  {Object}   data
 * @param  {Function} next
 */
var ajaxPlugin = function (data, next) {
  // Allow the proxy to be bypassed completely.
  if (data.proxy === false) {
    return next();
  }

  var url = App.Library.url.parse(data.url);

  // Attach the proxy if the url is not a relative url.
  if (url.protocol && url.host && url.host !== 'localhost') {
    data.url = App.Library.url.resolve(
      window.location.href, PROXY_URL + '/' + data.url
    );
  }

  return next();
};

/**
 * A { key: function } map of all middleware used in the plugin.
 *
 * @type {Object}
 */
module.exports = {
  'ajax': ajaxPlugin
};
