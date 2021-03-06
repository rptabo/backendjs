//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Nov 2014
//

var logger = require(__dirname + '/logger');
var core = require(__dirname + '/core');
var lib = require(__dirname + '/lib');
var aws = require(__dirname + '/aws');
var msg = require(__dirname + '/msg');

var client = {
    name: "sns",
};
module.exports = client;

msg.modules.push(client);

client.check = function(dev)
{
    return dev.urn.match(/^arn:aws:sns:/);
}

client.init = function(options)
{
}

client.close = function(callback)
{
    callback();
}

// Send push notification to a device using AWS SNS service, device_id must be a valid SNS endpoint ARN.
//
// The options may contain the following properties:
//  - msg - message text
//  - badge - badge number
//  - type - set type of the packet
//  - id - send id in the user properties
client.send = function(dev, options, callback)
{
    if (!dev.id) return lib.tryCall(callback, lib.newError("invalid device:" + dev));

    var pkt = {};
    // Format according to the rules per platform
    if (dev.id.match("/APNS/")) {
        if (options.msg) pkt.alert = options.msg;
        ["id","type","badge","sound","vibrate","account_id","url"].forEach(function(x) { if (options[x]) pkt[x] = options[x]; });
        pkt = { APNS: lib.stringify({ aps: pkt }) };
    } else
    if (dev.id.match("/GCM/")) {
        if (options.msg) pkt.message = options.msg;
        ["id","type","badge","sound","vibrate","account_id","url"].forEach(function(x) { if (options[x]) pkt[x] = options[x]; });
        pkt = { GCM: lib.stringify({ data: pkt }) };
    }
    aws.snsPublish(dev.id, pkt, callback);
    return true;
}
