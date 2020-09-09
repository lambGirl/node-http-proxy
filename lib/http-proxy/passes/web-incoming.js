var httpNative   = require('http'),
    httpsNative  = require('https'),
    web_o  = require('./web-outgoing'),
    common = require('../common'),
    followRedirects = require('follow-redirects');

/**
 * 得到所有web-outgoing导出的值的数组
 */
web_o = Object.keys(web_o).map(function(pass) {
  return web_o[pass];
});

// 本机的协议组合
var nativeAgents = { http: httpNative, https: httpsNative };

/*!
 * Array of passes.
 *
 * A `pass` is just a function that is executed on `req, res, options`
 * so that you can easily add new checks while still keeping the base
 * flexible.
 */


module.exports = {

  /**
   * HTTP DELETE 请求方法用于删除指定的资源。
   * 如果请求属于DELETE类型，则将“ content-length”设置为“ 0”。
   * Sets `content-length` to '0' if request is of DELETE type.
   *
   * @param {ClientRequest} Req Request object : Request object对象
   * @param {IncomingMessage} Res Response object: Response object对象
   * @param {Object} Options Config object passed to the proxy:需要通过proxy代理的配置
   *
   * @api private
   * content-length:  是一个实体消息首部，用来指明发送给接收方的消息主体的大小，即用十进制数字表示的八位元组的数目
   * transfer-encoding: 消息首部指明了将 entity 安全传递给用户所采用的编码形式https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers/Transfer-Encoding
   *
   * 如果DELETE/OPTIONS并且当content-length不存在时，将content-length设置为'0'; 删除对应的transfer-encoding
   */

  deleteLength: function deleteLength(req, res, options) {
    if((req.method === 'DELETE' || req.method === 'OPTIONS')
       && !req.headers['content-length']) {
      req.headers['content-length'] = '0';
      delete req.headers['transfer-encoding'];
    }
  },

  /**
   * Sets timeout in request socket if it was specified in options.
   * 如果在options中指定超时，则在socket request中设置为超时
   *
   * @param {ClientRequest} Req Request object : Request object对象
   * @param {IncomingMessage} Res Response object: Response object对象
   * @param {Object} Options Config object passed to the proxy: 需要通过proxy代理的配置
   *
   * @api private
   * 如果代理配置中options中设置了timeout的值，则需要设置socket的timeout
   * req.socket
   */

  timeout: function timeout(req, res, options) {
    if(options.timeout) {
      req.socket.setTimeout(options.timeout);
    }
  },

  /**
   * 如果在options中指定了对应的xfwd，则需要设置对应的配置
   * Sets `x-forwarded-*` headers if specified in config.
   * X-Forwarded-For(XFF): 用来记录客户端的信息(ip等)， 不管中间经历了多少个代理服务器
   * X-Forwarded-Proto (XFP)：为了确定客户端与负载均衡服务器之间所使用的协议 （ 是一个事实上的标准首部， 用来确定客户端与代理服务器或者负载均衡服务器之间的连接所采用的传输协议（HTTP 或 HTTPS））
   * X-Forwarded-Host (XFH) 是一个事实上的标准首部，用来确定客户端发起的请求中使用  Host  指定的初始域名。
   * @param {ClientRequest} Req Request object
   * @param {IncomingMessage} Res Response object
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  XHeaders: function XHeaders(req, res, options) {
    if(!options.xfwd) return;

    var encrypted = req.isSpdy || common.hasEncryptedConnection(req);
    var values = {
      for  : req.connection.remoteAddress || req.socket.remoteAddress,
      port : common.getPort(req),
      proto: encrypted ? 'https' : 'http'
    };

    ['for', 'port', 'proto'].forEach(function(header) {
      req.headers['x-forwarded-' + header] =
        (req.headers['x-forwarded-' + header] || '') +
        (req.headers['x-forwarded-' + header] ? ',' : '') +
        values[header];
    });

    req.headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers['host'] || '';
  },

  /**
   * Does the actual proxying. If `forward` is enabled fires up
   * a ForwardStream, same happens for ProxyStream. The request
   * just dies otherwise.
   * 做实际的代理。 如果启用了“转发”，则会触发一个ForwardStream，
   * 对于ProxyStream也是如此。 要求否则死亡。
   *
   * @param {ClientRequest} Req Request object
   * @param {IncomingMessage} Res Response object
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  stream: function stream(req, res, options, _, server, clb) {

    console.log('server', server.emit);
    // And we begin!
    //  感觉没有什么用
   server.emit('start', req, res, options.target || options.forward);

    // 地址变化
    var agents = options.followRedirects ? followRedirects : nativeAgents;
    var http = agents.http;
    var https = agents.https;

    if(options.forward) {
      console.log('----测试')
      // If forward enable, so just pipe the request
      var forwardReq = (options.forward.protocol === 'https:' ? https : http).request(
        common.setupOutgoing(options.ssl || {}, options, req, 'forward')
      );

      // error handler (e.g. ECONNRESET, ECONNREFUSED)
      // Handle errors on incoming request as well as it makes sense to
      var forwardError = createErrorHandler(forwardReq, options.forward);
      // 监听错误请求
      req.on('error', forwardError);
      forwardReq.on('error', forwardError);

      (options.buffer || req).pipe(forwardReq);
      // 如果target不存在直接让请求end。
      if(!options.target) { return res.end(); }
    }

    // Request initalization
    // 初始化代理服务器请求: common.setupOutgoing(options.ssl || {}, options, req)配置
    var proxyReq = (options.target.protocol === 'https:' ? https : http).request(
      common.setupOutgoing(options.ssl || {}, options, req)
    );

    // 使开发人员能够在发送标头之前修改proxyReq(http => request的event事件: socket)
    // Enable developers to modify the proxyReq before headers are sent
    proxyReq.on('socket', function(socket) {
      if(server && !proxyReq.getHeader('expect')) {
        server.emit('proxyReq', proxyReq, req, res, options);
      }
    });

    // allow outgoing socket to timeout so that we could
    // show an error page at the initial request
    if(options.proxyTimeout) {
      proxyReq.setTimeout(options.proxyTimeout, function() {
         proxyReq.abort();
      });
    }

    // Ensure we abort proxy if request is aborted
    // 当请求中止时触发。
    req.on('aborted', function () {
      proxyReq.abort();
    });

    // handle errors in proxy and incoming request, just like for forward proxy
    var proxyError = createErrorHandler(proxyReq, options.target);
    req.on('error', proxyError);
    proxyReq.on('error', proxyError);

    //
    function createErrorHandler(proxyReq, url) {
      return function proxyError(err) {
        if (req.socket.destroyed && err.code === 'ECONNRESET') {
          server.emit('econnreset', err, req, res, url);
          return proxyReq.abort();
        }

        if (clb) {
          clb(err, req, res, url);
        } else {
          server.emit('error', err, req, res, url);
        }
      }
    }

    (options.buffer || req).pipe(proxyReq);

    // 监听代理服务器的响应： 将最终的响应返回给浏览器
    proxyReq.on('response', function(proxyRes) {


      if(server) { server.emit('proxyRes', proxyRes, req, res); }

      if(!res.headersSent && !options.selfHandleResponse) {
        for(var i=0; i < web_o.length; i++) {
          if(web_o[i](req, res, proxyRes, options)) { break; }
        }
      }


      if (!res.finished) {
        // Allow us to listen when the proxy has completed
        proxyRes.on('end', function () {
          // 这边都是将所有代理的东西丢回去
          if (server) server.emit('end', req, res, proxyRes);
        });
        // We pipe to the response unless its expected to be handled by the user
        if (!options.selfHandleResponse) proxyRes.pipe(res);
      } else {
        // 将所有代理服务器的东西丢回去
        if (server) server.emit('end', req, res, proxyRes);
      }
    });
  }

};
