/**
 * node的工具
 * utilities -> util
 * URL -> url
 * eventemitter3: 事件监听器
 * http: http协议
 * https: HTTPS 是基于 TLS/SSL 的 HTTP 协议。在 Node.js 中，其被实现为一个单独的模块。
 * web: web的请求管理
 * ws: websocket的请求管理
 *
 */
var httpProxy = module.exports,
    extend    = require('util')._extend,
    parse_url = require('url').parse,
    EE3       = require('eventemitter3'),
    http      = require('http'),
    https     = require('https'),
    web       = require('./passes/web-incoming'),
    ws        = require('./passes/ws-incoming');

httpProxy.Server = ProxyServer;

/**
 * Returns a function that creates the loader for
 * either `ws` or `web`'s  passes.
 *
 * Examples:
 *
 *    httpProxy.createRightProxy('ws')
 *    // => [Function]
 *
 * @param {String} Type Either 'ws' or 'web'
 * 
 * @return {Function} Loader Function that when called returns an iterator for the right passes
 *
 * @api private
 */

function createRightProxy(type) {

  return function(options) {
    return function(req, res /*, [head], [opts] */) {
      // 获取到ws或者web对应的代理体
      var passes = (type === 'ws') ? this.wsPasses : this.webPasses,
          args = [].slice.call(arguments),
          cntr = args.length - 1,
          head, cbl;

      /* optional args parse begin */
      if(typeof args[cntr] === 'function') {
        cbl = args[cntr];
        cntr--;
      }

      // 传入的配置
      var requestOptions = options;
      if(
        !(args[cntr] instanceof Buffer) &&
        args[cntr] !== res
      ) {
        //Copy global options
        requestOptions = extend({}, options);
        //Overwrite with request options
        extend(requestOptions, args[cntr]);

        cntr--;
      }

      if(args[cntr] instanceof Buffer) {
        head = args[cntr];
      }

      /* optional args parse end */

      ['target', 'forward'].forEach(function(e) {
        if (typeof requestOptions[e] === 'string')
          requestOptions[e] = parse_url(requestOptions[e]);
      });

      // 如果配置体没有指定代理的服务则报错
      if (!requestOptions.target && !requestOptions.forward) {
        return this.emit('error', new Error('Must provide a proper URL as target'));
      }

      for(var i=0; i < passes.length; i++) {
        /**
         * Call of passes functions
         * pass(req, res, options, head)
         *
         * In WebSockets case the `res` variable
         * refer to the connection socket
         * pass(req, socket, options, head)
         */
        // 依次执行配置. 调用对应的方法。
        if(passes[i](req, res, requestOptions, head, this, cbl)) { // passes can return a truthy value to halt the loop
          break;
        }
      }
    };
  };
}
httpProxy.createRightProxy = createRightProxy;

function ProxyServer(options) {
  EE3.call(this);

  options = options || {};
  options.prependPath = options.prependPath === false ? false : true;

  // 声明及定义web服务
  this.web = this.proxyRequest           = createRightProxy('web')(options);
  // 声明及定义web服务
  this.ws  = this.proxyWebsocketRequest  = createRightProxy('ws')(options);
  // 定义需要的options
  this.options = options;


  // 组装所有的web的value ./passes/web-incoming.js
  this.webPasses = Object.keys(web).map(function(pass) {
    return web[pass];
  });
  // 组装所有的ws的value ./passes/ws-incoming.js
  this.wsPasses = Object.keys(ws).map(function(pass) {
    return ws[pass];
  });

  // 开启监听
  this.on('error', this.onError, this);

}

// 采用 util.inherits(constructor, superConstructor)。
require('util').inherits(ProxyServer, EE3);

// 添加onError
ProxyServer.prototype.onError = function (err) {
  //
  // Remark: Replicate node core behavior using EE3
  // so we force people to handle their own errors
  //
  if(this.listeners('error').length === 1) {
    throw err;
  }
};

// 原型链路上添加listen. 开启监听服务
ProxyServer.prototype.listen = function(port, hostname) {

  var self    = this,
      closure = function(req, res) {
        self.web(req, res);
      };


    // 判断服务类型，如果是ssl: 则代表是https。
    // closure: requestListener是一个自动添加到“ request”事件的函数
  this._server  = this.options.ssl ?
    https.createServer(this.options.ssl, closure) :
    http.createServer(closure);

  // 如果是ws服务。 升级connection为Upgrade. upgrade: websocket
  if(this.options.ws) {
    this._server.on('upgrade', function(req, socket, head) { self.ws(req, socket, head); });
  }

  // 开启监听
  this._server.listen(port, hostname);

  return this;
};

// 原型链路上添加close
ProxyServer.prototype.close = function(callback) {
  var self = this;
  if (this._server) {
    this._server.close(done);
  }

  // Wrap callback to nullify server after all open connections are closed.
  function done() {
    self._server = null;
    if (callback) {
      callback.apply(null, arguments);
    }
  };
};

// 原型链路上添加before
ProxyServer.prototype.before = function(type, passName, callback) {
  if (type !== 'ws' && type !== 'web') {
    throw new Error('type must be `web` or `ws`');
  }
  var passes = (type === 'ws') ? this.wsPasses : this.webPasses,
      i = false;

  passes.forEach(function(v, idx) {
    if(v.name === passName) i = idx;
  })

  if(i === false) throw new Error('No such pass');

  passes.splice(i, 0, callback);
};

// 原型链路上添加after
ProxyServer.prototype.after = function(type, passName, callback) {
  if (type !== 'ws' && type !== 'web') {
    throw new Error('type must be `web` or `ws`');
  }
  var passes = (type === 'ws') ? this.wsPasses : this.webPasses,
      i = false;

  passes.forEach(function(v, idx) {
    if(v.name === passName) i = idx;
  })

  if(i === false) throw new Error('No such pass');

  passes.splice(i++, 0, callback);
};
