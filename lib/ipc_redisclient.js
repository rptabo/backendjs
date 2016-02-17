//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var dns = require('dns');
var util = require('util');
var logger = require(__dirname + '/logger');
var core = require(__dirname + '/core');
var lib = require(__dirname + '/lib');
var ipc = require(__dirname + "/ipc");
var Client = require(__dirname + "/ipc_client");

// Cache/queue client based on Redis server using https://github.com/NodeRedis/node_redis
//
module.exports = IpcRedisClient;

function IpcRedisClient(url, options)
{
    Client.call(this, url, options);
    this.options.servers = lib.strSplitUnique(this.options.servers);
    if (this.options.servers.length) {
        var h = (this.hostname || "127.0.0.1") + ":" + (this.port || this.options.port || 6379);
        if (this.options.servers.indexOf(h) == -1) this.options.servers.push(h);
        if (this.options.servers.length > 1 && !this.options.connect_timeout && !this.options.max_attemtps) this.options.max_attempts = 10;
    }
    if (!this.options.connect_timeout) this.options.connect_timeout = 86400000;
    if (!this.options.retry_max_delay) this.options.retry_max_delay = 60000;
    this.initClient("client", this.hostname, this.port);
    if (this.options.sentinel || this.options.sentinelServers) this.initSentinel();
}
util.inherits(IpcRedisClient, Client);

IpcRedisClient.prototype.close = function()
{
    Client.prototype.close.call(this);
    if (this.client) this.client.quit();
    if (this.sentinel) this.sentinel.end();
}

IpcRedisClient.prototype.stats = function(options, callback)
{
    this.client.info(function(e,v) {
        v = lib.strSplit(v, "\n").filter(function(x) { return x.indexOf(":") > -1 }).map(function(x) { return x.split(":") }).reduce(function(x,y) { x[y[0]] = y[1]; return x }, {});
        callback(v);
    });
}

IpcRedisClient.prototype.keys = function(pattern, callback)
{
    this.client.keys(pattern || "*", function(e, keys) {
        callback(keys);
    });
}

IpcRedisClient.prototype.clear = function(pattern, callback)
{
    var self = this;
    if (pattern) {
        this.client.keys(pattern, function(e, keys) {
            if (e) return;
            for (var i in keys) {
                self.client.del(keys[i], lib.noop);
            }
            if (callback) callback();
        });
    } else {
        this.client.flushall(callback);
    }
}

IpcRedisClient.prototype.get = function(key, options, callback)
{
    this.client.get(key, function(e, v) {
        callback(v);
    });
}

IpcRedisClient.prototype.put = function(key, val, options, callback)
{
    var ttl = (options && lib.toNumber(options.ttl)) || lib.toNumber(this.options.ttl);
    if (ttl > 0) {
        this.client.setex([key, Math.ceil(ttl/1000), val], callback || lib.noop);
    } else {
        this.client.set([key, val], callback || lib.noop);
    }
}

IpcRedisClient.prototype.incr = function(key, val, options, callback)
{
    this.client.incrby(key, val, function(e, v) {
        if (typeof callback == "function") callback(v);
    });
}

IpcRedisClient.prototype.del = function(key, options, callback)
{
    this.client.del(key, callback || lib.noop);
}

IpcRedisClient.prototype.initClient = function(name, host, port)
{
    var opts = this.options[name] || this.options;
    host = String(host).split(":");
    var Redis = require("redis");
    var client = new Redis.createClient(host[1] || port || opts.port || 6379, host[0] || "127.0.0.1", opts);
    client.on("error", this.onError.bind(this, name));

    switch (name) {
    case "sentinel":
        client.on('pmessage', this.onSentinelMessage.bind(this));
        client.on("ready", this.onSentinelConnect.bind(this));
        break;

    default:
        client.on("ready", this.emit.bind(this, "ready"));
        client.on("message", this.emit.bind(this, "message"));
        client.on("connect", this.onConnect.bind(this, name));
    }

    if (this[name]) this[name].end();
    this[name] = client;
    logger.debug("initClient:", name, this.url, "connecting:", host, port);
}

IpcRedisClient.prototype.onConnect = function(name)
{
    logger.debug("redis:", name, this.url, "connected", this[name].address);
    this.emit("connect");
}

IpcRedisClient.prototype.onError = function(name, err)
{
    logger.error("redis:", name, err);
    if (err.code == 'CONNECTION_BROKEN') {
        this.emit("disconnect");
        var opts = this.options[name] || this.options;
        var host = opts.servers.shift();
        if (!host) return;
        opts.servers.push(host);
        logger.debug("disconnect:", name, this.url, "trying", host, "of", opts.servers);
        setTimeout(this.initClient.call(this, name, host), opts.reconnect_timeout || 50);
    }
}

IpcRedisClient.prototype.initSentinel = function()
{
    var options = {};
    for (var p in this.options) {
        if (p.match(/^sentinel/)) {
            var n = p.replace(/^sentinel/,"");
            if (!n) continue;
            options[n[0].toLowerCase() + n.substr(1)] = this.options[p];
            delete this.options[p];
        }
    }
    options.servers = lib.strSplitUnique(options.servers);
    // Need at least one server in the list for reconnect to work
    if (!options.servers.length) options.servers.push(this.options.sentinel || "");
    options.no_ready_check = false;
    options.enable_offline_queue = false;
    options.max_attempts = options.max_attempts || 10;
    options.port = options.port || 26379;
    options.name = options.name || "redis";
    this.options.sentinel = options;
    this.initClient("sentinel", options.servers[0]);
}

IpcRedisClient.prototype.onSentinelMessage = function(pattern, channel, msg)
{
    var self = this;
    logger.debug("onSentinelMessage:", self.url, channel, msg)

    if (channel[0] == "+" || channel[0] == "-") channel = channel.substr(1);
    switch(channel) {
    case "reset-master":
        this.onSentinelConnect();
        break;

    case "sentinel":
        msg = lib.strSplit(msg, " ");
        if (!msg[1] || msg[5] != this.options.sentinel.name) break;
        if (this.options.sentinel.servers.indexOf(msg[1]) == -1) this.options.sentinel.servers.push(msg[1]);
        break;

    case 'switch-master':
        msg = lib.strSplit(msg, ' ');
        if (!msg[3] || msg[0] != this.options.sentinel.name) break;
        if (this.client && this.client.address == msg[3] + ":" + msg[4]) break;
        logger.error("onSentinelMessage:", "switch-master:", this.url, msg);
        self.initClient.call(self, "client", msg[3], msg[4]);
        break;
    }
}

IpcRedisClient.prototype.onSentinelConnect = function()
{
    var self = this;
    logger.debug("onSentinelConnect:", this.url, this.options.sentinel);

    lib.series([
      function(next) {
          self.sentinel.punsubscribe(next);
      },
      function(next) {
          self.sentinel.send_command("SENTINEL", ["sentinels", self.options.sentinel.name], function(err, args) {
              if (err) return next(err);
              logger.debug("onSentinelConnect:", "sentinels", args);
              var servers = Array.isArray(args) ? args.map(function(x) { return x[1] }) : [];
              if (servers.indexOf(self.sentinel.address) == -1) servers.push(self.sentinel.address);
              if (servers.length) self.options.sentinel.servers = servers;
              next();
          });
      },
      function(next) {
          self.sentinel.send_command("SENTINEL", ["get-master-addr-by-name", self.options.sentinel.name], function(err, args) {
              if (err) return next(err);
              logger.debug("onSentinelConnect:", "master", args);
              var h = args[0] + ":" + args[1];
              if (args[0] && args[0] != self.hostname && args[1] != self.port && self.options.servers.indexOf(h) == -1) {
                  if (self.client && self.client.connected) {
                      self.options.servers.push(h);
                  } else {
                      self.initClient.call(self, "client", args[0], args[1]);
                  }
              }
              next();
          });
      },
      function(next) {
          self.sentinel.psubscribe('*', next);
      },
    ], function(err) {
        if (!err) return;
        logger.error("onSentinelConnect:", self.url, err);
        if (self.sentinel.connected) setTimeout(self.onSentinelConnect.bind(self), self.options.sentinel.retry_timeout || 500);
    });
}