goog.provide('pdfHighlighter');
goog.provide('pdfHighlighter.main');

goog.require('goog.Uri');
goog.require('goog.Uri.QueryData');
goog.require('goog.array');
goog.require('goog.dom');
goog.require('goog.dom.dataset');
goog.require('goog.events');
goog.require('goog.net.XhrIo');
goog.require('pdfHighlighter.util');

var ieVersion = pdfHighlighter.util.detectIE();

/** @constructor */
var HlInitedInfo = function() {
  this.elementListeners = [];
};

/** @export */
HlInitedInfo.prototype.unregister = function() {
  goog.array.forEach(this.elementListeners, function (item) {
    if (item.listener) {
      goog.events.unlisten(item.element, goog.events.EventType.CLICK, item.listener);
      goog.dom.dataset.remove(item.element, 'hlInited');
    }
    else {
      // fixme need recovery for href
    }
  });
};


var initPdfHighlighter = function (config, hlBase) {

  var cmdObject = new HlInitedInfo();

  config = config || {};

  var highlighterUrl = hlBase || config['highlighterUrl'] || window['HighlighterBase'] || "/";
  if (highlighterUrl.indexOf('/', highlighterUrl.length - 1) === -1)
    highlighterUrl += '/';

  var checkStatus = config['checkStatus'] === true;
  var resolveDocumentBase = pdfHighlighter.util.getFirstBoolean([config['sendAbsoluteUrlsToHighlighter'], config['resolveDocumentBase'], true]);
  var resolveXmlBase = pdfHighlighter.util.getFirstBoolean([config['sendAbsoluteUrlsToHighlighter'], config['resolveXmlBase'], true]);
  var resolveViewUrl = pdfHighlighter.util.getFirstBoolean([config['sendAbsoluteUrlsToHighlighter'], config['resolveViewUrl'], true]);

  var viewerUrl = config['viewerUrl'];
  var encodeHashForViewer = false;
  var target = config['documentLinkSelector'];
  var apiToken;
  var attachDisabled = config['attach'] === false;

  if (!goog.isDefAndNotNull(target) && !attachDisabled) {
    target = "a[href*='.pdf'], a[href*='.PDF']";
  }

  var links = [];
  if (goog.isString(target)) {
    links = document.querySelectorAll(target);
  }
  else if (goog.isArrayLike(target)) {
    links = target;
  }
  else if (!attachDisabled) {
    console.log('Highlighter target not defined.');
    return false;
  }

  if (config.debug) {
    console.log('Attaching highlighter to links: ' + links.length);
  }

  if (checkStatus && (links.length > 0 || attachDisabled)) {
    var statusReqData = config['statusCheckParams'];
    checkServerStatus(highlighterUrl, statusReqData,
      function onSuccess(res) {
        cmdObject['serverStatus'] = res;
        if (res['success'] && !res['disabled']) {
          var endpoint = res['endpoint'] || highlighterUrl;
          if (res['apiToken'])
            apiToken = res['apiToken'];
          attachHighlighterForAll(links, endpoint);
        }
        else {
          attachHighlighterForAll(links, undefined);
          console.log('PDF highlighting disabled by server.');
        }
      },
      function onError() {
        cmdObject['serverStatus'] = {'success': false};
        // fixme pass error to config fn listener?
        // in case of error, continue with highlighting disabled (as click may be handled by an external handler to e.g. open viewer)
        attachHighlighterForAll(links, undefined);
        console.log('PDF highlighting disabled because status check failed.');
      });
  }
  else {
    attachHighlighterForAll(links, highlighterUrl);
  }


  function attachHighlighterForAll(links, highlighterUrl) {
    if (attachDisabled) {
      return;
    }
    goog.array.forEach(links, function (item, index, arr) {
      var r = attachHighlighter(item, highlighterUrl, apiToken);
      if (goog.isObject(r)) {
        cmdObject.elementListeners.push(r);
      }
    });
  }

  cmdObject['attach'] = function (el) {
    attachHighlighter(el, highlighterUrl);
  };

  function attachHighlighter(el, highlighterUrl) {

    if (goog.dom.dataset.get(el, 'hlInited') === 'true') {
      return;
    }

    var highlightUrlBuilder = getHighlightUrlBuilder(config);
    var self = el;
    var addedListener;

    if (typeof config['updateAttr'] === 'string') {
      var data = collectParameters(el, config);
      var url = highlightUrlBuilder(highlighterUrl, getHighlightingMethodForParams(data), data);
      if (url)
        el.setAttribute(config['updateAttr'], url);
    }

    // if updateHref is enabled, update href and exit
    if (config['updateHref'] === true) {
      var data = collectParameters(el, config);
      var url = highlightUrlBuilder(highlighterUrl, getHighlightingMethodForParams(data), data);
      if (url) {
        if (config['viewer']) {
          url = buildViewerUrl(config['viewer'], {
            'file': data['uri'],
            'highlightsFile': url
          });
        }
        var orig = el.getAttribute('href');
        if (orig)
          goog.dom.dataset.set(el, 'hlOrigHref', orig);
        el.setAttribute('href', url);
      }
    }
    else { // otherwise listen for a click...
      goog.events.listen(el, goog.events.EventType.CLICK, clickListener);
      addedListener = clickListener;
    }

    function clickListener(e) {

      var data = collectParameters(self, config);
      var method = getHighlightingMethodForParams(data);
      var postUrl = highlightUrlBuilder(highlighterUrl, method); // building url without data as we'll use POST method
      var dataEncoded = goog.Uri.QueryData.createFromMap(data).toString();

      if (typeof config['onHighlightingLinkClick'] === 'function') {
        var ctx = {};
        ctx['highlighterUrl'] = highlighterUrl;
        ctx['highlightingMethod'] = method;
        ctx['endpoint'] = postUrl;
        ctx['params'] = data;
        ctx['paramsEncoded'] = dataEncoded;
        ctx['apiToken'] = apiToken;
        if (config['onHighlightingLinkClick'](self, ctx, e) === false) {
          return; // if callback returned false, ignoring the click
        }
      }

      // post URL is undefined if parameter validation failed so we exit before canceling the event
      if (!postUrl)
        return;
      e.preventDefault();

      var target = e.target.getAttribute('target');

      if (config['viewer']) {
        var viewUrl = buildViewerUrl(config['viewer'], {
          'file': data['uri'],
          'highlightsFile': postUrl + '?' + dataEncoded
        });
        showDocument(viewUrl, viewerUrl, encodeHashForViewer, target || config['target']);
        return;
      }

      var request = new goog.net.XhrIo();
      request.headers.set('accept', 'application/json');
      request.headers.set('content-type', 'application/x-www-form-urlencoded');
      if (apiToken) {
        request.headers.set('x-api-token', apiToken);
      }
      else request.headers.set('x-api-token', 'demo'); // fixme delete
      goog.events.listen(request, 'complete', function () {
        if (request.isSuccess()) {
          var res = request.getResponseJson();
          if (typeof config['onHighlightingResult'] === 'function') {
            if (config['onHighlightingResult'](res, self) === false) {
              return; // if callback returned false, ignoring click
            }
          }
          if (res['success'] === true) {
            showDocument(res['documentUrl'], viewerUrl, encodeHashForViewer, target || config['target']);
          }
          else {
            onError();
          }
        } else {
          onError();
          // print error info to the console
          console.log(
            'Something went wrong in the ajax call. Error code: ', request.getLastErrorCode(),
            ' - message: ', request.getLastError()
          );
        }
      });

      // start the request by setting POST method and passing the data object converted to a queryString
      request.send(postUrl, 'POST', dataEncoded);
    }

    function collectParameters(el, config) {
      var data = {};

      if (typeof config['apiKey'] === 'string') {
        data['apiKey'] = config['apiKey'];
      }

      var url = window.location.href;
      var dirUrl = url.substring(0, url.lastIndexOf("/") + 1);

      var href = el.getAttribute('href');
      var hrefHasXmlRef = false; // this flag gives advantage to xml hl (over query) for more sane defaults used by lightbox
      if (!href) {
        href = goog.dom.dataset.get(el, 'href');
      }
      if (href) {
        data['uri'] = pdfHighlighter.util.resolvePath(href, dirUrl, resolveDocumentBase);
        hrefHasXmlRef = href.indexOf('xml=') !== -1;
      }

      var altUrl = goog.dom.dataset.get(el, 'altUrl');
      if (!altUrl && href && !config['viewer'])
        altUrl = pdfHighlighter.util.resolvePath(href, dirUrl, resolveDocumentBase);


      var queryProvider;
      if (typeof config['querySelector'] === 'function') {
        queryProvider = config['querySelector'];
      }
      else if (typeof config['querySelector'] === 'string' && config['querySelector'].length > 0) {
        queryProvider = function () {
          return getQueryForSelector(config['querySelector'], config['maxQueryLen']);
        };
      }
      var queryFromProvider = queryProvider ? queryProvider() : undefined;


      var query = config.query || queryFromProvider || pdfHighlighter.util.findData(el, 'query');
      if (query && !hrefHasXmlRef) {
        if (typeof config['filterQuery'] === 'function') {
          query = config['filterQuery'](query);
        }
        data['query'] = query;
      }
      else if (href) {
        // lookup for PDF highlighting URL format
        var ind = href.indexOf('#xml='); // all but IE
        if (ind === -1)
          ind = href.indexOf('?xml='); // in IE
        if (ind === -1) {
          var xml = goog.dom.dataset.get(el, 'xml');
          if (xml) {
            if (xml.match(new RegExp('/<xml/i')))
              data['xml'] = xml;
            else
              data['xml'] = pdfHighlighter.util.resolvePath(xml, dirUrl, resolveXmlBase);
          }
        }
        else {
          var pdf = href.substring(0, ind); // TODO need to be url-decoded if from param?
          var xml = href.substring(ind + 5);
          data['uri'] = pdfHighlighter.util.resolvePath(pdf, dirUrl, resolveDocumentBase);
          data['xml'] = pdfHighlighter.util.resolvePath(xml, dirUrl, resolveXmlBase);
        }
      }

      if (data['uri']) {
        // todo is this proper encoding? see http://stackoverflow.com/questions/1634271/url-encoding-the-space-character-or-20
        if (altUrl && data['uri'] !== altUrl) // send altUrl only if different
          data['altUrl'] = altUrl.replace(/ /g, '%20');
        data['uri'] = data['uri'].replace(/ /g, '%20');
      }

      var viewUrl = goog.dom.dataset.get(el, 'viewUrl');
      if (viewUrl)
        data['viewUrl'] = pdfHighlighter.util.resolvePath(viewUrl, dirUrl, resolveViewUrl);

      addParameter(data, el, 'removePagesWithoutMatches', config['removePagesWithoutMatches']);
      addParameter(data, el, 'addNavigation', config['addNavigation']);
      addParameter(data, el, 'openFirstHlPage', config['openFirstHlPage']);
      addParameter(data, el, 'neighbourPages', config['neighbourPages']);
      addParameter(data, el, 'language', config['language']);
      addParameter(data, el, 'pdf.highlightColor', null);
      addParameter(data, el, 'pdf.highlightMarkupOpacity', null);
      addParameter(data, el, 'pdf.highlightGsAlpha', null);
      addParameter(data, el, 'documentServingPath', config['documentServingPath']);
      addParameter(data, el, 'navigation', config['navigation']);

      // giving a chance to client to amend highlighting parameters
      if (typeof config['updateHighlightingParams'] === 'function') {
        // function can either update the object or return a new one
        var newData = config['updateHighlightingParams'](data);
        if (newData)
          data = newData;
      }

      return data;
    }

    function onError() {
      //window.location = altUrl;
      // fixme improve error handling!
    }

    goog.dom.dataset.set(el, 'hlInited', 'true');
    return {
      element: el,
      listener: addedListener
    };
  }

  return cmdObject;
};

function showDocument(docUrl, viewerUrl, encodeHashForViewer, target) {

  var url = docUrl;
  if (viewerUrl) {
    if (!encodeHashForViewer) {
      var urlParts = docUrl.split('#');
      url = viewerUrl + encodeURIComponent(urlParts[0]);
      if (urlParts.length > 1)
        url += '#' + urlParts[1];
    }
    else {
      url = viewerUrl + encodeURIComponent(docUrl);
    }
  }

  // TODO: custom handler?

  if (typeof target === 'string') {
    window.open(url, target);
  }
  else {
    window.location = url;
  }
}

function checkServerStatus(highlighterUrl, statusReqData, onSuccess, onError) {
  var dataEncoded = statusReqData ? goog.Uri.QueryData.createFromMap(statusReqData).toString() : undefined;
  var request = new goog.net.XhrIo();
  request.headers.set('accept', 'application/json');
  goog.events.listen(request, 'complete', function () {
    var statusCode = request.getStatus();
    if (request.isSuccess() && statusCode < 400) {
      var res = request.getResponseJson();
      onSuccess(res);
    } else {
      console.log(
        'Something went wrong in the ajax call. HTTP status: ' + statusCode + ' - ' + request.getStatusText() +
        '; Error: ' + request.getLastErrorCode() + ' - ' + request.getLastError()
      );
      if (onError) {
        onError(request);
      }
    }
  });
  var statusUrl = highlighterUrl + 'status';
  if (dataEncoded) {
    statusUrl += '?' + dataEncoded;
  }
  request.send(statusUrl, 'GET', dataEncoded);
}

function getHighlightUrlBuilder(config) {
  var highlightUrlBuilder;
  if (typeof config['highlightUrlBuilder'] === 'function') {
    highlightUrlBuilder = config['highlightUrlBuilder'];
  }
  else {
    highlightUrlBuilder = function (highlighterUrl, method, data) {
      var hlActionUrl = config['highlightActionUrl'];
      if (!hlActionUrl) {
        if (!method || !highlighterUrl)
          return undefined; // params not valid
        hlActionUrl = highlighterUrl + method;
      }
      if (data) {
        var qd = goog.Uri.QueryData.createFromMap(data);
        var uri = goog.Uri.parse(hlActionUrl);
        uri.setQueryData(qd);
        hlActionUrl = uri.toString();
      }
      return hlActionUrl;
    };
  }
  return highlightUrlBuilder;
}

function getHighlightingMethodForParams(params) {
  if (params['uri'] === undefined)
    return undefined;
  if (params['xml'] !== undefined)
    return 'highlight-for-xml';
  if (params['query'] !== undefined)
    return 'highlight-for-query';
  return undefined;
}

function getQueryForSelector(querySelector, maxQueryLen) {
  // todo add support for getting query from URL parameter?
  if (querySelector) {
    // split selector by comma and search one by one for prioritized handling
    try {
      var sels = querySelector.split(',');
      for (var i = 0; i < sels.length; i++) {
        var sel = sels[i];
        if (sel.trim().length === 0)
          continue;
        var q = _getQueryForSelector(sel, maxQueryLen);
        if (q)
          return q;
      }
    }
    catch(e) { // in case of any error fall back to search without splitting
      return _getQueryForSelector(querySelector, maxQueryLen);
    }
  }
}

function _getQueryForSelector(querySelector, maxQueryLen) {
  var query;
  var elements = document.querySelectorAll(querySelector);
  // get the first found element from which we obtained text
  for (var i = 0; i < elements.length; i++) {
    var element = elements[i];
    if (element) {
      if (isInputBox(element)) {
        query = element.value;
      }
      else {
        // assuming we're dealing with HTML element so get its text
        query = element.textContent;
      }
      query = query.trim();
      if (maxQueryLen && query.length > maxQueryLen) {
        query = query.substring(0, maxQueryLen);
      }
      if (query.length !== 0)
        return query;
    }
  }
  return query;
}

function isInputBox(element) {
  var tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea') return true;
  if (tagName !== 'input') return false;
  var type = element.getAttribute('type').toLowerCase();
  // if any of these input types is not supported by a browser, it will behave as input type text.
  var inputTypes = ['text', 'number', 'email', 'search', 'hidden'];
  return inputTypes.indexOf(type) >= 0;
}

function isPdfViewerCompatible() {
  if (!window.addEventListener) { // require a modern browser
    return false;
  }
  else if (ieVersion !== false && ieVersion < 10) {
    return false;
  }
  return true;
}

function getBool(value) {
  return value == '1' || value == 'true'; // note: on purpose not using ===
}

function buildViewerUrl(viewerConf, params) {
  var viewUrl = viewerConf['url'] + '?';

  if (params['file'])
    viewUrl += 'file=' + encodeURIComponent(params['file']);
  if (params['downloadFile'])
    viewUrl += '&downloadFile=' + encodeURIComponent(params['downloadFile']);

  if (params['highlightsFile']) {
    var highlightsUrl = params['highlightsFile'];
    // If viewer URL is built with highlighting URL, we extend with 'includeHits' parameter so we get matches
    // JSON right away instead being redirected to viewer.
    if (highlightsUrl.indexOf('includeHits=') === -1)
      highlightsUrl += '&includeHits=true';
    viewUrl += '&highlightsFile=' + encodeURIComponent(highlightsUrl);
  }

  if (viewerConf['proxyXhr']) {
    // tell viewer to proxy network requests (for PDF document and highlighting) using messaging via this window
    // in order to avoid CORS issues when the viewer is hosted on an external CDN
    viewUrl += '&xhrProxy=parent';
  }

  if (!getBool(viewerConf['downBtnShow']))
    viewUrl += '&downBtnShow=0';
  if (getBool(viewerConf['downBtnText']))
    viewUrl += '&downBtnText=1';
  if (getBool(viewerConf['hideHlErrors']))
    viewUrl += '&hideHlErrors=1';
  if (getBool(viewerConf['hideHlMessages']))
    viewUrl += '&hideHlMessages=1';
  if (viewerConf['hit'])
    viewUrl += '&hit=' + viewerConf['hit'];
  if (!getBool(viewerConf['printBtnShow']))
    viewUrl += '&printBtnShow=0';
  if (getBool(viewerConf['printBtnText']))
    viewUrl += '&printBtnText=1';
  if (getBool(viewerConf['nativePrint']))
    viewUrl += '&nativePrint=1';
  if (getBool(viewerConf['bookmarkBtnShow']))
    viewUrl += '&bookmarkBtnShow=1';
  if (getBool(viewerConf['presModeShow']))
    viewUrl += '&presModeShow=1';
  if (viewerConf['style'])
    viewUrl += '&style=' + encodeURIComponent(viewerConf['style']);
  if (viewerConf['script'])
    viewUrl += '&script=' + encodeURIComponent(viewerConf['script']);
  if (viewerConf['favicon'])
    viewUrl += '&favicon=' + encodeURIComponent(viewerConf['favicon']);

  return viewUrl;
}

/** @export */
pdfHighlighter.init = function (config, hlBase) {
  return initPdfHighlighter(config, hlBase);
};

/** @export */
pdfHighlighter.initOnDOMContentLoaded = function (config, hlBase) {
  // Wait for DOM content to initialize
  switch(document.readyState) {
    case 'complete':
    case 'loaded':
    case 'interactive':
      initPdfHighlighter(config, hlBase);
      break;
    default:
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('DOMContentLoaded', function(e) {
          initPdfHighlighter(config, hlBase);
        }, false);
      }
  }
};

/** @export */
pdfHighlighter.initPdfHighlighter = initPdfHighlighter;

/** @export */
pdfHighlighter.getQueryForSelector = getQueryForSelector;

/** @export */
pdfHighlighter.isPdfViewerCompatible = isPdfViewerCompatible;
