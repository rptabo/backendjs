//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

exports.backend = require(__dirname + '/build/Release/backend');
exports.core = require(__dirname + '/core');
exports.logger = require(__dirname + '/logger');
exports.ipc = require(__dirname + '/ipc');
exports.aws = require(__dirname + '/aws');
exports.db = require(__dirname + '/db');
exports.server = require(__dirname + '/server');
exports.api = require(__dirname + '/api');
exports.metrics = require(__dirname + '/metrics');

exports.core.addContext('logger', exports.logger, 'ipc', exports.ipc, 'db', exports.db, 'aws', exports.aws, 'api', exports.api, 'server', exports.server);
exports.run = function(callback) { this.core.run(callback); }