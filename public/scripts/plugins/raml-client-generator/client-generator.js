/* global App */
var _      = App._;
var qs     = App.Library.querystring;
var trim   = require('trim');
var cases  = App.Library.changeCase;
var escape = require('escape-regexp');
var parser = require('uri-template');

var __toString           = Object.prototype.toString;
var HTTP_METHODS         = ['get', 'head', 'put', 'post', 'patch', 'delete'];
var RETURN_PROPERTY      = '@return';
var DESCRIPTION_PROPERTY = '@description';
var RESERVED_METHODS     = _.object(
  HTTP_METHODS.concat('headers', 'query'), true
);

/**
 * Required authentication keys used to check the options object.
 *
 * @type {Object}
 */
var requiredAuthKeys = {
  oauth1: {
    consumerKey:    true,
    consumerSecret: true
  },
  oauth2: {
    clientId:     true,
    clientSecret: true
  },
  basicAuth: {
    username: true,
    password: true
  }
};

/**
 * Returns an object of keys with whether they are required or not.
 *
 * @param  {String} type
 * @param  {Object} options
 * @return {Object}
 */
var requiredKeys = function (type, options) {
  var requiredKeys = _.extend({}, requiredAuthKeys[type]);

  // Special case is required for OAuth2 implicit auth flow.
  if (type === 'oauth2' && _.contains(options.authorizationGrants, 'token')) {
    requiredKeys.clientSecret = false;
  }

  return requiredKeys;
};

/**
 * Return an array of keys that are still required to be filled.
 *
 * @param  {String} type
 * @param  {Object} options
 * @return {Array}
 */
var requiredOptions = function (type, options) {
  var keys = requiredKeys(type, options);

  return _.filter(_.keys(keys), function (key) {
    return keys[key] && !options[key];
  });
};

/**
 * Trigger the middleware prompt for tokens.
 *
 * @param {String}   type
 * @param {Object}   options
 * @param {Function} done
 */
var middlewarePrompt = function (type, options, done) {
  return App.middleware.trigger('ramlClient:' + type, options, done);
};

/**
 * Execute the full authentication prompt. This includes requesting the
 * middleware and/or prompting the user to fill the values.
 *
 * @param {String}   type
 * @param {Object}   options
 * @param {Function} done
 */
var fullPrompt = function (type, options, done) {
  return middlewarePrompt(type, options, function (err, options) {
    if (err) { return done(err); }

    if (!requiredOptions(type, options).length) {
      return done(null, options);
    }

    var title = {
      oauth1:    'Please Enter Your OAuth1 Keys',
      oauth2:    'Please Enter Your OAuth2 Keys',
      basicAuth: 'Please Enter Your Username and Password'
    }[type];

    return App.middleware.trigger('ui:modal', {
      title: title,
      content: [
        '<p>',
        'This API requires authentication. Please enter your application keys.',
        '</p>',
        '<p><em>',
        'We will not store your keys.',
        '</em></p>'
      ].concat([
        '<form>',
        _.map(requiredOptions(type, options), function (required) {
          var value = options[required] || '';

          return [
            '<div class="form-group">',
            '<label for="' + required + '">' + required + '</label>',
            '<input id="' + required + '" value="' + value + '">',
            '</div>'
          ].join('');
        }).join('\n'),
        '<div class="form-footer">',
        '<button type="submit" class="btn btn-primary">Submit</button>',
        '</div>',
        '<form>'
      ]).join('\n'),
      show: function (modal) {
        modal.el.querySelector('form')
          .addEventListener('submit', function (e) {
            e.preventDefault();

            _.each(this.querySelectorAll('input'), function (inputEl) {
              options[inputEl.getAttribute('id')] = inputEl.value;
            });

            // Close the modal once all the options have been
            modal.close();
          });
      }
    }, function (err) {
      return done(err, options);
    });
  });
};

/**
 * Trigger the authentication flow immediately or after we attempt to grab
 * the configuration options.
 *
 * @param {String}   type
 * @param {Object}   options
 * @param {Function} done
 */
var authenticatePrompt = function (type, options, done) {
  var cb = function (err, data) {
    if (err) { return done(err); }

    // Extend the options object with generated options.
    _.extend(options, data);
    return App.middleware.trigger('authenticate:' + type, options, done);
  };

  // Check against the required options.
  if (!requiredOptions(type, options).length) {
    return cb();
  }

  return fullPrompt(type, options, cb);
};

/**
 * Runs validation logic against uri parameters from the RAML spec. Throws an
 * error with the validation issue when the validation fails.
 *
 * @param  {*}      value
 * @param  {Object} param
 * @return {Boolean}
 */
var validateParam = function (value, param) {
  var stringify = JSON.stringify;

  // Do an initial check for the required value and fail early.
  if (param.required === true && value == null) {
    throw new ReferenceError(param.displayName + ' is not defined');
  }

  // If it has a value, we can proceed with the rest of the checks.
  if (value != null) {
    if (param.type === 'string') {
      // Check the passed in value is a number.
      if (!_.isString(value)) {
        throw new TypeError('Expected a string, but got ' + stringify(value));
      }

      // Validate against the enum list.
      if (_.isArray(param.enum) && !_.contains(param.enum, value)) {
        throw new Error([
          'Expected a value of', param.enum.join(', ') + ',',
          'but got', stringify(value)
        ].join(' '));
      }

      // Validate the string length against the minimum required length.
      var minLength = param.minLength;
      if (minLength === +minLength && value.length < minLength) {
        throw new Error([
          'Expected a minimum length of', minLength + ',',
          'but got a length of', value.length
        ].join(' '));
      }

      // Validate the string length against the maximum allowed length.
      var maxLength = param.maxLength;
      if (maxLength === +maxLength && value.length > maxLength) {
        throw new Error([
          'Expected a maximum length of', maxLength + ',',
          'but got a length of', value.length
        ].join(' '));
      }

      // Validate the string against the pattern.
      var pattern = param.pattern;
      if (_.isString(pattern) && !(new RegExp(pattern).test(value))) {
        throw new Error('Expected the value to match ' + pattern);
      }
    } else if (param.type === 'integer' || param.type === 'number') {
      if (param.type === 'number') {
        // Validates that the value is a number and not `NaN`.
        if (value !== +value) {
          throw new TypeError('Expected a number, but got' + stringify(value));
        }
      } else {
        // Validates that the value is an integer and not `NaN`.
        if (value !== parseInt(value, 10)) {
          throw new TypeError(
            'Expected an integer, but got ' + stringify(value)
          );
        }
      }

      if (param.minimum === +param.minimum && value < param.minimum) {
        throw new Error('Expected a value larger than ' + param.minimum +
          ', but got ' + stringify(value));
      }

      if (param.maximum === +param.maximum && value > param.maximum) {
        throw new Error('Expected a value smaller than ' + param.minimum +
          ', but got ' + stringify(value));
      }
    } else if (param.type === 'date') {
      // Validate that the value is a date.
      if (!_.isDate(value)) {
        throw new TypeError('Expected a date, but got ' + stringify(value));
      }
    } else if (param.type === 'boolean') {
      // Validate the value is a boolean.
      if (!_.isBoolean(value)) {
        throw new TypeError('Expected a boolean, but got ' + stringify(value));
      }
    }
  }

  return true;
};

/**
 * Pass a whole query params object through the param validation function.
 *
 * @param  {Object}  object
 * @param  {Object}  params
 * @return {Boolean}
 */
var validateParams = function (object, params) {
  object = object || {};

  _.each(params, function (validate, param) {
    return validateParam(object[param], validate);
  });

  return true;
};

/**
 * Accepts a params object and transforms it into a regex for matching the
 * tokens in the route.
 *
 * @param  {Object} params
 * @return {RegExp}
 */
var uriParamRegex = function (params) {
  // Transform the params into a regular expression for matching.
  return new RegExp('{(' + _.map(_.keys(params), function (param) {
    return escape(param);
  }).join('|') + ')}', 'g');
};

/**
 * Simple "template" function for working with the uri param variables.
 *
 * @param  {String}       template
 * @param  {Object}       params
 * @param  {Object|Array} context
 * @return {String}
 */
var template = function (string, params, context) {
  // If the context is an array, we need to transform the replacements into
  // index based positions for the uri template parser.
  if (_.isArray(context)) {
    var index = -1;

    string = string.replace(uriParamRegex(params), function (match, param) {
      validateParam(context[++index], params[param]);
      return '{' + index + '}';
    });
  } else {
    validateParams(context, params);
  }

  return parser.parse(string).expand(context);
};

/**
 * Transform a general RAML method describing object into a tooltip
 * documentation object.
 *
 * @param  {Object} object
 * @return {Object}
 */
var toDescriptionObject = function (object) {
  var description = {};

  // Documentation/description is usually available.
  description['!doc'] = object.description;

  return description;
};

/**
 * Sanitize the AST from the RAML parser into something easier to work with.
 *
 * @param  {Object} ast
 * @return {Object}
 */
var sanitizeAST = function (ast) {
  if (!_.isString(ast.baseUri)) {
    throw new Error('A baseUri is required');
  }

  // Merge an array of objects into a single object using `_.extend` and
  // `apply` (since `_.extend` accepts unlimited number of arguments).
  ast.traits          = _.extend.apply(_, ast.traits);
  ast.resourceTypes   = _.extend.apply(_, ast.resourceTypes);
  ast.securitySchemes = _.extend.apply(_, ast.securitySchemes);

  // Recurse through the resources and move URIs to be the key names.
  ast.resources = (function flattenResources (resources) {
    var map = {};

    // Resources are provided as an array, we'll move them to be an object.
    _.each(resources, function (resource) {
      // Methods are implemented as arrays of objects too, but not recursively.
      if (resource.methods) {
        resource.methods = _.object(
          _.pluck(resource.methods, 'method'), resource.methods
        );
      }

      if (resource.resources) {
        resource.resources = flattenResources(resource.resources);
      }

      (function attachResource (object, segments) {
        var segment = segments.shift();

        // Only the one segment part left, embed the entire resource.
        if (!segments.length) {
          return object[segment] = resource;
        }

        // Pull any potential tags out of the relative uri part.
        var tags = _.map(segment.match(/\{([^\{\}]+)\}/g), function (tag) {
          return tag.slice(1, -1);
        });

        // Nested segments need access to the relative uri parameters.
        object[segment] = {
          // Extends any resources already attached to the same property.
          resources: _.extend({}, object[segment] && object[segment].resources),
          // Dodgy `relativeUri` patch.
          relativeUri: '/' + segment,
          // Pick out the applicable template tags.
          uriParameters: _.pick(resource.uriParameters, tags)
        };

        // Remove the segment from the original relative uri.
        resource.relativeUri = resource.relativeUri.substr(segment.length + 1);

        // Remove tags no longer applicable to other parts.
        // Note: This *will* break if the same tag name is in multiple parts.
        resource.uriParameters = _.omit(resource.uriParameters, tags);

        return attachResource(object[segment].resources, segments);
      })(map, resource.relativeUri.substr(1).split('/'));
    });

    return map;
  })(ast.resources);

  // Parse the root url and inject variables.
  ast.baseUri = template(ast.baseUri, ast.baseUriParameters, ast);

  return ast;
};

/**
 * List of all plain HTTP methods in the format from the AST.
 *
 * @type {Object}
 */
var httpMethods = _.chain(HTTP_METHODS).map(function (method) {
    return [method, {
      method: method
    }];
  }).object().value();

/**
 * Map of methods to their tooltip description objects.
 *
 * @type {Object}
 */
var methodDescription = {
  'get': {
    '!type': 'fn(query?: object, async?: ?)'
  },
  'head': {
    '!type': 'fn(query?: object, async?: ?)'
  },
  'put': {
    '!type': 'fn(body?: ?, async?: ?)'
  },
  'post': {
    '!type': 'fn(body?: ?, async?: ?)'
  },
  'patch': {
    '!type': 'fn(body?: ?, async?: ?)'
  },
  'delete': {
    '!type': 'fn(body?: ?, async?: ?)'
  }
};

/**
 * Parse an XHR request for response headers and return as an object. Pass an
 * additional flag to filter any potential duplicate headers (E.g. different
 * cases).
 *
 * @param  {Object}  xhr
 * @param  {Boolean} [filterDuplicates]
 * @return {Object}
 */
var getReponseHeaders = function (xhr, filterDuplicates) {
  var responseHeaders = {};

  _.each(xhr.getAllResponseHeaders().split('\n'), function (header) {
    header = header.split(':');

    // Make sure we have both parts of the header.
    if (header.length > 1) {
      var name  = header.shift();
      var value = trim(header.join(':'));

      // Lowercase the header name to filter duplicate headers.
      if (filterDuplicates) {
        name = name.toLowerCase();
      }

      responseHeaders[name] = value;
    }
  });

  return responseHeaders;
};

/**
 * Check that the XHR request has a response body.
 *
 * @param  {Object}  xhr
 * @return {Boolean}
 */
var hasBody = function (xhr) {
  return !!xhr.responseText.length;
};

/**
 * Return the xhr response mime type.
 *
 * @param  {String} contentType
 * @return {String}
 */
var getMime = function (contentType) {
  return (contentType || '').split(';')[0];
};

/**
 * Check if the mime type matches JSON.
 *
 * @param  {String}  mime
 * @return {Boolean}
 */
var isJSON = function (mime) {
  // https://github.com/senchalabs/connect/blob/
  // 296398a001d97fd0e8dafa622fc75c874a06c3d6/lib/middleware/json.js#L78
  return (/^application\/([\w!#\$%&\*`\-\.\^~]*\+)?json$/i).test(mime);
};

/**
 * Check if the mime type matches url encoding.
 *
 * @param  {String}  mime
 * @return {Boolean}
 */
var isUrlEncoded = function (mime) {
  return mime === 'application/x-www-form-urlencoded';
};

/**
 * Check if the mime type matches form data.
 *
 * @param  {String}  mime
 * @return {Boolean}
 */
var isFormData = function (mime) {
  return mime === 'multipart/form-data';
};

/**
 * Gets a header from the header object.
 *
 * @param  {Object}  headers
 * @param  {String}  header
 * @return {Boolean}
 */
var getHeader = function (headers, header) {
  header = header.toLowerCase();

  return _.find(headers, function (value, name) {
    return name.toLowerCase() === header;
  });
};

/**
 * Sanitize the XHR request into the desired format.
 *
 * @param  {XMLHttpRequest} xhr
 * @return {Object}
 */
var sanitizeXHR = function (xhr) {
  if (!xhr) { return xhr; }

  var mime    = getMime(xhr.getResponseHeader('Content-Type'));
  var body    = xhr.responseText;
  var headers = getReponseHeaders(xhr);

  if (hasBody(xhr)) {
    if (isJSON(mime)) {
      body = JSON.parse(body);
    } else if (isUrlEncoded(mime)) {
      body = qs.parse(body);
    }
  }

  return {
    body:    body,
    status:  xhr.status,
    headers: headers
  };
};

/**
 * Returns a function that can be used to make ajax requests.
 *
 * @param  {String}   url
 * @return {Function}
 */
var httpRequest = function (nodes, method) {
  return function (data, done) {
    var async   = !!done;
    var query   = nodes.query   || {};
    var headers = nodes.headers || {};
    var mime    = getMime(getHeader(headers, 'Content-Type'));
    var request = 'ajax';
    var fullUrl = nodes.client.baseUri + '/' + nodes.join('/');
    var response, error; // Weird async and sync code mixing.

    // No need to pass data through with `GET` or `HEAD` requests.
    if (method.method === 'get' || method.method === 'head') {
      // If we passed in an argument, it should be set as the query string.
      if (data != null) {
        query = data;
      }

      // Unset the data object.
      data = null;
    }

    // Make sure the passed in `query` is an object for validation.
    if (query != null && !_.isObject(query)) {
      query = qs.parse(query);
    }

    // Pass the query parameters through validation and append to the url.
    if (validateParams(query, method.queryParameters)) {
      query = qs.stringify(query);

      fullUrl += query ? '?' + query : '';
    }

    // Set the correct Content-Type header, if none exists. Kind of random if
    // more than one exists - in that case I would suggest setting it yourself.
    if (!mime && typeof method.body === 'object') {
      headers['Content-Type'] = mime = _.keys(method.body).pop();
    }

    var canSerialize = {
      '[object Array]':  true,
      '[object Object]': true
    };

    // If we were passed in data, attempt to sanitize it to the correct type.
    if (canSerialize[__toString.call(data)]) {
      if (isJSON(mime)) {
        data = JSON.stringify(data);
      } else if (isUrlEncoded(mime)) {
        data = qs.stringify(data);
      } else if (isFormData(mime)) {
        // Attempt to use the form data object - available in newer browsers.
        var formData = new FormData();
        _.each(data, function (value, key) {
          formData.append(key, value);
        });

        // Set the data to the form data instance.
        data     = formData;
        formData = null;
      }
    }

    var options = {
      url:     fullUrl,
      data:    data,
      async:   async,
      proxy:   nodes.config.proxy, // Disable proxying data.
      method:  method.method,
      headers: headers
    };

    // Iterate through `securedBy` methods and accept the first one we are
    // already authenticated for.
    _.some(method.securedBy || nodes.client.securedBy, function (secured) {
      // Skip unauthorized requests since we'll be doing that anyway if the
      // rest of the secure methods fail to exist.
      if (secured == null) {
        return false;
      }

      var scheme        = nodes.client.securitySchemes[secured];
      var authenticated = nodes.client.authentication[scheme.type];

      if (authenticated) {
        if (scheme.type === 'OAuth 2.0') {
          request        = 'ajax:oauth2';
          options.oauth2 = authenticated;
        } else if (scheme.type === 'OAuth 1.0') {
          request        = 'ajax:oauth1';
          options.oauth1 = authenticated;
        } else if (scheme.type === 'Basic Authentication') {
          request           = 'ajax:basicAuth';
          options.basicAuth = authenticated;
        }

        return true;
      }

      return false;
    });

    // If the request is async, set the relevant function callbacks.
    if (async) {
      App._executeContext.timeout(Infinity);

      if (!_.isFunction(done)) {
        done = App._executeContext.async();
      }
    }

    // Trigger the ajax middleware so plugins can hook onto the requests. If the
    // function is async we need to register a callback for the middleware.
    App.middleware.trigger(request, options, function (err, xhr) {
      error    = err;
      response = sanitizeXHR(xhr);

      return async && done(err, response);
    });

    // If the request was synchronous, return the sanitized XHR response data.
    // This is super jank for handling errors, etc.
    if (!async) {
      if (error) {
        throw error;
      }

      return response;
    }
  };
};

/**
 * Attach the query string helper.
 *
 * @param  {Array}  nodes
 * @param  {Object} context
 * @param  {Object} methods
 * @return {Object}
 */
var attachQuery = function (nodes, context, methods) {
  if ('query' in nodes) {
    return context;
  }

  var routeNodes = _.extend([], nodes, {
    query: null
  });

  context.query = function (query) {
    routeNodes.query = query;
    return attachMethods(routeNodes, {}, methods);
  };

  context.query[RETURN_PROPERTY] = attachMethods(routeNodes, {}, methods);

  return context;
};

/**
 * Attach the headers helper.
 *
 * @param  {Array}  nodes
 * @param  {Object} context
 * @param  {Object} methods
 * @return {Object}
 */
var attachHeaders = function (nodes, context, methods) {
  if ('headers' in nodes) {
    return context;
  }

  var routeNodes = _.extend([], nodes, {
    headers: null
  });

  context.headers = function (headers) {
    if (typeof headers !== 'object') {
      throw new Error('Ajax headers must be provided as an object');
    }

    routeNodes.headers = headers;
    return attachMethods(routeNodes, {}, methods);
  };

  context.headers[RETURN_PROPERTY] = attachMethods(routeNodes, {}, methods);

  return context;
};

/**
 * Attaches executable XHR methods to the context object.
 *
 * @param  {Array}  nodes
 * @param  {Object} context
 * @param  {Object} methods
 * @return {Object}
 */

// Disable JSHint throwing an error about `attachMethods` being used before it
// was defined, since it is being used in `attachHeaders` and `attachQuery`.

/* jshint -W003 */
var attachMethods = function (nodes, context, methods) {
  // Skip attaching any method related methods if it there aren't any methods at
  // this endpoint.
  if (methods == null || !_.keys(methods).length) {
    return context;
  }

  attachQuery(nodes, context, methods);
  attachHeaders(nodes, context, methods);

  // Iterate over all the possible methods and attach.
  _.each(methods, function (method, verb) {
    context[verb] = httpRequest(nodes, method);
    context[verb][DESCRIPTION_PROPERTY] = _.extend(
      toDescriptionObject(method), methodDescription[verb]
    );
  });

  return context;
};
/* jshint +W003 */

/**
 * Recurses through a resource object in the RAML AST, generating a dynamic
 * DSL that only allows methods that were defined in the RAML spec.
 *
 * @param  {Array}  nodes     An array of path nodes that can be joined.
 * @param  {Object} context   Where to attach the resource routes.
 * @param  {Object} resources An object of resource routes.
 * @return {Object}           Returns the passed in context object.
 */
var attachResources = function attachResources (nodes, context, resources) {
  _.each(resources, function (resource, route) {
    var routeName = route;
    var resources = resource.resources;
    // Use `extend` to clone the nodes since we attach meta data directly to
    // the nodes.
    var routeNodes   = _.extend([], nodes);
    var templateTags = resource.uriParameters && _.keys(resource.uriParameters);

    // Push the current route into the route array.
    routeNodes.push(route);

    if (templateTags && templateTags.length) {
      // The route must end with template tags and have no intermediate text
      // between template tags.
      if (/^.*(?:\{[^\{\}]+\})+$/.test(route)) {
        var templateCount = templateTags.length;

        // If the route is only a template tag with no static text, use the
        // template tag text as the method name.
        if (templateCount === 1 && route === '{' + templateTags[0] + '}') {
          routeName = templateTags[0];
        } else {
          routeName = route.substr(0, route.indexOf('{'));
        }

        // Don't add reserved methods to the context. This is done to avoid
        // potentially confusing use cases. *Was it `get` to make the request
        // or to set the path?*
        if (!routeName || _.has(RESERVED_METHODS, routeName)) {
          return false;
        }

        // The route is dynamic, so we set the route name to be a function
        // which accepts the template arguments and updates the path fragment.
        // We'll extend any route already at the same namespace so we can do
        // things like use both `/{route}` and `/route`, if needed.
        context[routeName] = _.extend(function () {
          if (arguments.length < templateCount) {
            throw new Error([
              'Insufficient parameters, expected at least',
              templateCount, 'arguments'
            ].join(' '));
          }

          // Change the last path fragment to the proper template text.
          routeNodes[routeNodes.length - 1] = template(
            route, resource.uriParameters, _.toArray(arguments)
          );

          var newContext = {};
          attachMethods(routeNodes, newContext, resource.methods);
          return attachResources(routeNodes, newContext, resources);
        }, context[routeName]);

        // Get the ordered tag names for completion.
        var tags = _.map(
          route.match(uriParamRegex(resource.uriParameters)),
          function (param) {
            return resource.uriParameters[param.slice(1, -1)];
          }
        );

        // Generate the description object for helping tooltip display.
        context[routeName][DESCRIPTION_PROPERTY] = {
          // Create a function type hint based on the display name and whether
          // the tag is required.
          '!type': 'fn(' + _.map(tags, function (param) {
            var displayName = param.displayName + (!param.required ? '?' : '');

            return displayName + ': ' + (param.type || '?');
          }).join(', ') + ')',
          // Generate documentation by joining all the template descriptions
          // together with new lines.
          '!doc': _.chain(tags).uniq().filter(function (param) {
            return !!param.description;
          }).map(function (param) {
            return '"' + param.displayName + '": ' + param.description;
          }).value().join('\n')
        };

        // Generate the return property for helping autocompletion.
        var returnPropContext = {};
        attachMethods(routeNodes, returnPropContext, resource.methods);
        attachResources(routeNodes, returnPropContext, resources);
        return context[routeName][RETURN_PROPERTY] = returnPropContext;
      } else {
        return false;
      }
    }

    // If the route is only static text we can easily add the next route.
    var newContext = context[routeName] || (context[routeName] = {});
    attachMethods(routeNodes, newContext, resource.methods);
    return attachResources(routeNodes, newContext, resources);
  });

  return context;
};

/**
 * Attach an authentication method that delegates to middleware.
 *
 * @param  {String}   trigger
 * @param  {Array}    nodes
 * @param  {Object}   scheme
 * @return {Function}
 */
var authenticateMiddleware = function (trigger, nodes, scheme) {
  return function (data, done) {
    if (!_.isFunction(done)) {
      done = App._executeContext.async();
    }

    // Generate the options using user data.
    var options = _.extend({}, scheme.settings, data);

    // Timeout after 10 minutes.
    App._executeContext.timeout(10 * 60 * 1000);

    return authenticatePrompt(trigger, options, function (err, auth) {
      // Set the client authentication details. This will be used with any
      // http requests that require the authentication type.
      nodes.client.authentication[scheme.type] = _.extend({}, auth, options);
      return done(err, auth);
    });
  };
};

/**
 * Map the supported auth types to the known triggers.
 *
 * @type {Object}
 */
var authTypes = {
  'OAuth 1.0':            'oauth1',
  'OAuth 2.0':            'oauth2',
  'Basic Authentication': 'basicAuth'
};

/**
 * Attaches all available security schemes to the context.
 *
 * @param  {Array}  nodes
 * @param  {Object} context
 * @param  {Object} schemes
 * @return {Object}
 */
var attachSecuritySchemes = function (nodes, context, schemes) {
  // Loop through the available schemes and manually attach each of the
  // available schemes.
  _.each(schemes, function (scheme, title) {
    if (!authTypes[scheme.type]) { return; }

    var type   = authTypes[scheme.type];
    var method = 'authenticate' + cases.pascal(title);
    var keys   = requiredKeys(type, scheme.settings);

    context[method] = authenticateMiddleware(type, nodes, scheme);
    context[method][DESCRIPTION_PROPERTY] = _.extend(
      toDescriptionObject(scheme),
      {
        '!type': 'fn(options: {' + _.map(keys, function (value, key) {
          return key + (value ? '' : '?') + ': string';
        }).join(', ') + '})'
      }
    );
  });

  return context;
};

/**
 * Generate the client object from a sanitized AST object.
 *
 * @param  {Object} ast Passed through `sanitizeAST`
 * @return {Object}
 */
var generateClient = function (ast, config) {
  // Generate the root node array. Set properties directly on this array to be
  // copied to the next execution part. In some cases we may need something to
  // be automatically set on *all* instances, so we use `config` since objects
  // are passed by reference.
  var nodes = _.extend([], {
    config: config || {},
    client: {
      baseUri:         ast.baseUri.replace(/\/+$/, ''),
      securedBy:       ast.securedBy,
      authentication:  {},
      securitySchemes: ast.securitySchemes
    }
  });

  /**
   * The root client implementation is simply a function. This allows us to
   * enter a custom path that may not be supported by the DSL and run any
   * method regardless of whether it was defined in the spec.
   *
   * @param  {String} path
   * @param  {Object} context
   * @return {Object}
   */
  var client = function (path, context) {
    var route = template(
      path, {}, context || {}
    ).replace(/^\/+/, '').split('/');

    return attachMethods(_.extend([], nodes, route), {}, httpMethods);
  };

  // Enable the `@return` property used by the completion plugin.
  client[RETURN_PROPERTY] = attachMethods(nodes, {}, httpMethods);

  // Enable the `@description` property used by the completion tooltip helper.
  client[DESCRIPTION_PROPERTY] = {
    '!type': 'fn(url: string, data?: object)',
    '!doc': [
      'Make an API request to a custom URL. Pass in a `data` object to replace',
      'any template tags before making the request.'
    ].join(' ')
  };

  // Attach all the resources to the returned client function.
  attachResources(nodes, client, ast.resources);

  // Attach security scheme authentication to the root node.
  attachSecuritySchemes(nodes, client, ast.securitySchemes);

  return client;
};

/**
 * Exports the client generator, which accepts the AST of a RAML document.
 *
 * @return {Object} Dynamic object for constructing API requests from the AST.
 */
module.exports = function (ast, config) {
  return generateClient(sanitizeAST(ast), config);
};
