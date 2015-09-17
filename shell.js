//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var net = require('net');
var cluster = require('cluster');
var domain = require('domain');
var cron = require('cron');
var path = require('path');
var util = require('util');
var url = require('url');
var fs = require('fs');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var core = require(__dirname + '/core');
var lib = require(__dirname + '/lib');
var logger = require(__dirname + '/logger');
var db = require(__dirname + '/db');
var aws = require(__dirname + '/aws');
var ipc = require(__dirname + '/ipc');
var api = require(__dirname + '/api');
var app = require(__dirname + '/app');
var jobs = require(__dirname + '/jobs');
var os = require('os');

var shell = {
    name: "shell",
}

module.exports = shell;

// Exit and write to the console a message or error message if non empty
shell.exit = function(err, msg)
{
    if (err) console.log(err);
    if (msg) console.log(msg);
    process.exit(err ? 1 : 0);
}

// Resolves a user from `obj.id` or `obj.login` params and return the record in the callback
shell.getUser = function(obj, callback)
{
    db.get("bk_account", { id: obj.id }, function(err, row) {
        if (err) exit(err);

        db.get("bk_auth", { login: row ? row.login : obj.login }, function(err, row) {
            if (err || !row) exit(err, "ERROR: no user found with this id: " + util.inspect(obj));
            callback(row);
        });
    });
}

// Returns an object with all command line params that do not start with dash(-), treat 2 subsequent parms without dashes as name value pair
shell.getQuery = function()
{
    var query = {};
    for (var i = process.argv.length - 1; i > 1; i -= 2) {
        var a = process.argv[i - 1][0], b = process.argv[i][0];
        if (a != '-' && b != '-') query[process.argv[i - 1]] = process.argv[i];
    }
    return query;
}

// Returns an object with all command line params starting with dash set with the value if the next param does not start with dash or 1
shell.getArgs = function()
{
    var query = {};
    for (var i = process.argv.length - 1; i > 1; i -= 2) {
        var a = process.argv[i - 1][0], b = process.argv[i][0];
        if (a == '-') query[process.argv[i - 1].substr(1)] = b != '-' ? process.argv[i] : 1;
    }
    return query;
}

// Returns an object with all command line params starting with dash set with the value if the next param does not start with dash or 1,
// this is API query emulaton and only known API parameters will be set, all other config options must be handled by each command separately
shell.getOptions = function()
{
    return api.getOptions({ query: this.getArgs(), options: { path: ["", "", ""], ops: {} } });
}

// Return first available value for the given name, options first, then command arg and then default
shell.getArg = function(name, options, dflt)
{
    return decodeURIComponent(String((options && options[lib.toCamel(name.substr(1))]) || core.getArg(name, dflt))).trim();
}

shell.getArgInt = function(name, options, dflt)
{
    return lib.toNumber(this.getArg(name, options, dflt));
}

shell.isArg = function(name, options)
{
    return typeof options[lib.toCamel(name.substr(1))] != "undefined" || core.isArg(name);
}

// Start REPL shell or execute any subcommand if specified in the command line.
// A subcommand may return special string to indicate how to treat the flow:
// - stop - stop processing commands and create REPL
// - continue - do not exit and continue processing other commands or end with REPL
// - all other values will result in returning from the run assuming the command will decide what to do, exit or continue running, no REPL is created
shell.run = function(options)
{
    var self = this;
    process.title = core.name + ": shell";

    logger.debug('startShell:', process.argv);

    core.runMethods("configureShell", options, function(err, opts) {
        if (opts.done) exit();

        ipc.initServer();

        for (var i = 1; i < process.argv.length; i++) {
            if (process.argv[i][0] != '-') continue;
            var name = lib.toCamel("cmd" + process.argv[i]);
            if (typeof self[name] != "function") continue;
            var rc = self[name](opts);
            if (rc == "stop") break;
            if (rc == "continue") continue;
            return;
        }
        core.createRepl();
    });
}

// App version
shell.cmdShowInfo = function(options)
{
    var ver = core.appVersion.split(".");
    console.log('mode=' + core.runMode);
    console.log('name=' + core.appName);
    console.log('version=' + core.appVersion);
    console.log('major=' + (ver[0] || 0));
    console.log('minor=' + (ver[1] || 0));
    console.log('patch=' + (ver[2] || 0));
    console.log('ipaddr=' + core.ipaddr);
    console.log('network=' + core.network);
    console.log('subnet=' + core.subnet);
    for (var p in core.instance) if (core.instance[p]) console.log(p + '=' + core.instance[p]);
    this.exit();
}

// Run API server inside the shell
shell.cmdRunApi = function(options)
{
    api.init();
    return "continue";
}

// Run a test command inside the shell
shell.cmdTestRun = function(options)
{
    var tests = require(__dirname + "/tests");
    core.addModule("tests", tests);
    if (fs.existsSync(core.cwd + "/tests.js")) require(core.cwd + "/tests.js");
    tests.run();
}

// Add a user
shell.cmdAccountAdd = function(options)
{
    var self = this;
    if (!core.modules.accounts) exit("accounts module not loaded");
    var query = this.getQuery();
    var opts = this.getOptions();
    if (core.isArg("-scramble")) opts.scramble = 1;
    if (query.login && !query.name) query.name = query.login;
    core.modules.accounts.addAccount({ query: query, account: { type: 'admin' } }, opts, function(err, data) {
        self.exit(err, data);
    });
}

// Delete a user and all its history according to the options
shell.cmdAccountUpdate = function(options)
{
    var self = this;
    if (!core.modules.accounts) this.exit("accounts module not loaded");
    var query = this.getQuery();
    var opts = this.getOptions();
    if (core.isArg("-scramble")) opts.scramble = 1;
    this.getUser(query, function(row) {
        core.modules.accounts.updateAccount({ account: row, query: query }, opts, function(err, data) {
            self.exit(err, data);
        });
    });
}

// Delete a user and all its history according to the options
shell.cmdAccountDel = function(options)
{
    var self = this;
    if (!core.modules.accounts) this.exit("accounts module not loaded");
    var query = this.getQuery();
    var opts = {};
    for (var i = 1; i < process.argv.length - 1; i += 2) {
        if (process.argv[i] == "-keep") opts[process.argv[i + 1]] = 1;
    }
    this.getUser(query, function(row) {
        core.modules.accounts.deleteAccount(row.id, opts, function(err, data) {
            self.exit(err, data);
        });
    });
}

// Update location
shell.cmdLocationPut = function(options)
{
    var self = this;
    if (!core.modules.locations) this.exit("locations module not loaded");
    var query = this.getQuery();
    this.getUser(query, function(row) {
        core.modules.locations.putLocation({ account: row, query: query }, {}, function(err, data) {
            self.exit(err, data);
        });
    });
}

// Run logwatcher and exit
shell.cmdLogWatch = function(options)
{
    var self = this;
    core.watchLogs(function(err) {
        self.exit(err);
    });
}

// Show all config parameters
shell.cmdDbGetConfig = function(options)
{
    var self = this;
    var opts = this.getQuery();
    var sep = core.getArg("-separator", "=");
    var fmt = core.getArg("-format");
    db.initConfig(opts, function(err, data) {
        if (fmt == "text") {
            for (var i = 0; i < data.length; i += 2) console.log(data[i].substr(1) + (sep) + data[ i + 1]);
        } else {
            console.log(JSON.stringify(data));
        }
        self.exit(err);
    });
}

// Show all tables
shell.cmdDbTtables = function(options)
{
    var sep = core.getArg("-separator", "\n");
    var tables = db.getPoolTables(db.pool, { names: 1 });
    console.log(tables.join(sep));
    this.exit(err);
}

// Show record that match the search criteria, return up to `-count N` records
shell.cmdDbSelect = function(options)
{
    var self = this;
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = core.getArg("-table");
    var sep = core.getArg("-separator", "!");
    var fmt = core.getArg("-format");
    var cols = Object.keys(db.getColumns(table))
    db.select(table, query, opts, function(err, data) {
        if (data && data.length) {
            if (fmt == "text") {
                data.forEach(function(x) { console.log((cols || Object.keys(x)).map(function(y) { return x[y] }).join(sep)) });
            } else {
                data.forEach(function(x) { console.log(JSON.stringify(x)) });
            }
        }
        self.exit(err);
    });
}

// Show all records that match search criteria
shell.cmdDbScan = function(options)
{
    var self = this;
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = core.getArg("-table");
    var sep = core.getArg("-separator", "!");
    var fmt = core.getArg("-format");
    var cols = Object.keys(db.getColumns(table));
    db.scan(table, query, opts, function(row, next) {
        if (fmt == "text") {
            console.log((cols || Object.keys(row)).map(function(y) { return row[y] }).join(sep));
        } else {
            console.log(JSON.stringify(row));
        }
        next();
    }, function(err) {
        self.exit(err);
    });
}

// Save all tables to the specified directory or the server home
shell.cmdDbBackup = function(options)
{
    var self = this;
    var opts = this.getArgs();
    var query = this.getQuery();
    var root = core.getArg("-path");
    var filter = core.getArg("-filter");
    var tables = lib.strSplit(core.getArg("-tables"));
    var skip = lib.strSplit(core.getArg("-skip"));
    if (!opts.useCapacity) opts.useCapacity = "read";
    if (!opts.factorCapacity) opts.factorCapacity = 0.25;
    if (!tables.length) tables = db.getPoolTables(db.pool, { names: 1 });
    lib.forEachSeries(tables, function(table, next) {
        if (skip.indexOf(table) > -1) return next();
        file = path.join(root, table +  ".json");
        fs.writeFileSync(file, "");
        db.scan(table, query, opts, function(row, next2) {
            if (filter && app[filter]) app[filter](table, row);
            fs.appendFileSync(file, JSON.stringify(row) + "\n");
            next2();
        }, function() {
            next();
        });
    }, function(err) {
        logger.info("dbBackup:", root, tables, opts);
        self.exit(err);
    });
}

// Restore tables
shell.cmdDbRestore = function(options)
{
    var self = this;
    var opts = this.getArgs();
    var root = core.getArg("-path");
    var filter = core.getArg("-filter");
    var tables = lib.strSplit(core.getArg("-tables"));
    var skip = lib.strSplit(core.getArg("-skip"));
    var files = lib.findFileSync(root, { depth: 1, types: "f", include: /\.json$/ });
    if (core.isArg("-drop")) opts.drop = 1;
    if (core.isArg("-continue")) opts.continue = 1;
    opts.errors = 0;
    lib.forEachSeries(files, function(file, next3) {
        var table = path.basename(file, ".json");
        if (tables.length && tables.indexOf(table) == -1) return next3();
        if (skip.indexOf(table) > -1) return next3();
        var cap = db.getCapacity(table);
        opts.readCapacity = cap.readCapacity;
        opts.writeCapacity = cap.writeCapacity;
        lib.series([
            function(next) {
                if (!opts.drop) return next();
                db.drop(table, opts, next);
            },
            function(next) {
                if (!opts.drop) return next();
                setTimeout(next, opts.timeout || 500);
            },
            function(next) {
                if (!opts.drop) return next();
                db.create(table, db.getTableProperties(table, opts), opts, next);
            },
            function(next) {
                if (!opts.drop) return next();
                setTimeout(next, options.timeout || 500);
            },
            function(next) {
                if (!opts.drop) return next();
                db.cacheColumns(opts, next);
            },
            function(next) {
                lib.forEachLine(file, opts, function(line, next2) {
                    var row = lib.jsonParse(line, { error: 1 });
                    if (!row) return next2(opts.continue ? null : "ERROR: parse error, line: " + opts.nlines);
                    if (filter && app[filter]) app[filter](table, row);
                    db.put(table, row, opts, function(err) {
                        if (err && !opts.continue) return next2(err);
                        if (err) opts.errors++;
                        db.checkCapacity(cap, next2);
                    });
                }, next);
            }], next3);
    }, function(err) {
        logger.info("dbRestore:", root, tables || files, opts);
        self.exit(err);
    });
}

// Put config entry
shell.cmdDbGet = function(options)
{
    var self = this;
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = core.getArg("-table");
    var sep = core.getArg("-separator", "!");
    var fmt = core.getArg("-format");
    var cols = Object.keys(db.getColumns(table))
    db.get(table, query, opts, function(err, data) {
        if (data) {
            if (fmt == "text") {
                console.log((cols || Object.keys(data)).map(function(y) { return x[y] }).join(sep))
            } else {
                console.log(JSON.stringify(data));
            }
        }
        self.exit(err);
    });
}

// Put a record
shell.cmdDbPut = function(options)
{
    var self = this;
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = core.getArg("-table");
    db.put(table, query, opts, function(err, data) {
        self.exit(err);
    });
}

// Delete a record
shell.cmdDbDel = function(options)
{
    var self = this;
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = core.getArg("-table");
    db.del(table, query, opts, function(err, data) {
        self.exit(err);
    });
}

// Delete all records
shell.cmdDbDelAll = function(options)
{
    var self = this;
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = core.getArg("-table");
    db.delAll(table, query, opts, function(err, data) {
        self.exit(err);
    });
}

// Drop a table
shell.cmdDbDrop = function(options)
{
    var self = this;
    var opts = this.getArgs();
    var table = core.getArg("-table");
    db.drop(table, opts, function(err, data) {
        self.exit(err);
    });
}

// Send API request
shell.cmdSendRequest = function(options)
{
    var self = this;
    var query = this.getQuery();
    var url = core.getArg("-url");
    var id = core.getArg("-id");
    var login = core.getArg("-login");
    this.getUser({ id: id, login: login }, function(row) {
        core.sendRequest({ url: url, login: row.login, secret: row.secret, query: query }, function(err, params) {
            self.exit(err, params.obj);
        });
    });
}

// Check all names in the tag set for given name pattern(s), all arguments after 0 are checked
shell.awsCheckTags = function(obj, name)
{
    var tags = lib.objGet(obj, "tagSet.item", { list: 1 });
    if (!tags.length) return false;
    for (var i = 1; i < arguments.length; i++) {
        if (!arguments[i]) continue;
        var rx = new RegExp(String(arguments[i]), "i");
        if (tags.some(function(t) { return t.key == "Name" && rx.test(t.value); })) return true;
    }
    return false;
}

// Return matched subnet ids by availability zone and/or name pattern
shell.awsFilterSubnets = function(subnets, zone, name)
{
    var self = this;
    return subnets.filter(function(x) {
        if (zone && zone != x.availabilityZone.split("-").pop()) return 0;
        return name ? self.awsCheckTags(x, name) : 1;
    }).map(function(x) {
        return x.subnetId;
    });
}

// Return instances from the response object
shell.awsGetInstances = function(rc)
{
    var list = lib.objGet(rc, "DescribeInstancesResponse.reservationSet.item", { obj: 1 });
    list = lib.objGet(list, "instancesSet.item", { list: 1 });
    list.forEach(function(x) {
        x.name = lib.objGet(x, "tagSet.item", { list: 1 }).filter(function(x) { return x.key == "Name" }).map(function(x) { return x.value }).pop();
    });
    return list;
}

// Retrieve my AMIs for the given name pattern
shell.getSelfImages = function(name, callback)
{
    aws.queryEC2("DescribeImages",
                 { 'Owner.0': 'self',
                   'Filter.1.Name': 'name',
                   'Filter.1.Value': name
                 }, function(err, rc) {
        if (err) return callback(err);
        var images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
        // Sort by version in descending order, assume name-N.N.N naming convention
        images.sort(function(a, b) {
            var n1 = a.name.split("-");
            n1[1] = lib.toVersion(n1[1]);
            var n2 = b.name.split("-");
            n2[1] = lib.toVersion(n2[1]);
            return n1[0] > n2[0] ? -1 : n1[0] < n2[0] ? 1 : n2[1] - n1[1];
        });
        callback(null, images);
    });
}

// Return Amazon AMIs for the current region, HVM type only
shell.getAmazonImages = function(options, callback)
{
    var query = { 'Owner.0': 'amazon',
        'Filter.1.Name': 'name',
        'Filter.1.Value': options.filter || 'amzn-ami-hvm-*',
        'Filter.2.Name': 'architecture',
        'Filter.2.Value': options.arch || 'x86_64',
        'Filter.3.Name': 'root-device-type',
        'Filter.3.Value': options.rootdev || 'ebs',
        'Filter.4.Name': 'block-device-mapping.volume-type',
        'Filter.4.Value': options.devtype || 'gp2',
    };
    if (core.isArg("-dry-run")) {
        logger.log("getAmazonImages:", query);
        return callback(null, []);
    }
    aws.queryEC2("DescribeImages", query, function(err, rc) {
        if (err) return callback(err);
        var images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
        images.sort(function(a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0 });
        callback(null, images);
    });
}

// Wait ELB to have instance count equal or not to the expected total
shell.getElbCount = function(name, equal, total, options, callback)
{
    var running = 1, count = 0, expires = Date.now() + (options.timeout || 180000);

    lib.doWhilst(
        function(next) {
            aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: name }, function(err, rc) {
                if (err) return next(err);
                count = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 }).filter(function(x) { return x.State == "InService"}).length;
                logger.log("getElbCount:", name, "checking(" + (equal ? "=" : "<>") + "):", "in-service", count, "out of", total);
                if (equal) {
                    running = total == count && Date.now() < expires;
                } else {
                    running = total != count && Date.now() < expires;
                }
                setTimeout(next, running ? (options.interval || 5000) : 0);
            });
        },
        function() {
            return running;
        },
        function(err) {
            callback(err, total, count);
        });
}

// Launch instances by run mode and/or other criteria
shell.launchInstances = function(options, callback)
{
    var self = this;
    var subnets = [], instances = [];
    var appName = self.getArg("-app-name", options, core.appName);
    var appVersion = self.getArg("-app-version", options, core.appVersion);

    var req = {
        count: self.getArgInt("-count", options, 1),
        vpcId: self.getArg("-vpc-id", options, aws.vpcId),
        instanceType: self.getArg("-instance-type", options, aws.instanceType),
        imageId: self.getArg("-image-id", options, aws.imageId),
        subnetId: self.getArg("-subnet-id", options, aws.subnetId),
        keyName: self.getArg("-key-name", options, aws.keyName) || appName,
        elbName: self.getArg("-elb-name", options, aws.elbName),
        groupId: self.getArg("-group-id", options, aws.groupId),
        iamProfile: self.getArg("-ami-profile", options, aws.iamProfile) || appName,
        data: self.getArg("-user-data", options),
        terminate: self.isArg("-no-terminate", options) ? 0 : 1,
        name: self.getArg("-tag-name", options, appName + "-" + appVersion),
        alarmName: self.getArg("-alarm-name", options),
        alarms: [],
    };
    logger.debug("launchInstances:", req);

    lib.series([
       function(next) {
           if (req.imageId) return next();
           var imageName = self.getArg("-image-name", options, '*');
           self.getSelfImages(imageName, function(err, rc) {
               if (err) return next(err);

               // Give preference to the images with the same app name
               if (rc.length) {
                   var rx = new RegExp("^" + appName, "i");
                   for (var i = 0; i < rc.length && !req.imageId; i++) {
                       if (rc[i].name.match(rx)) req.imageId = rc[i].imageId;
                   }
                   if (!req.imageId) req.imageId = rc[0].imageId;
               }
               if (!req.imageId) return next("ERROR: AMI must be specified or discovered by filters");
               next(err);
           });
       },
       function(next) {
           if (req.groupId) return next();
           var filter = self.getArg("-group-name", options, appName + "|^default$");
           aws.ec2DescribeSecurityGroups({ filter: filter }, function(err, rc) {
               if (!err) req.groupId = rc.map(function(x) { return x.groupId });
               next(err);
           });
       },
       function(next) {
           // Verify load balancer name
           if (self.isArg("-no-elb", options)) return next();
           aws.queryELB("DescribeLoadBalancers", {}, function(err, rc) {
               if (err) return next(err);

               var list = lib.objGet(rc, "DescribeLoadBalancersResponse.DescribeLoadBalancersResult.LoadBalancerDescriptions.member", { list: 1 });
               if (req.elbName) {
                   if (!list.filter(function(x) { return x.LoadBalancerName == req.elbName }).length) return next("ERROR: Invalid load balancer " + aws.elbName);
               } else {
                   req.elbName = list.filter(function(x) { return x.LoadBalancerName.match("^" + appName) }).map(function(x) { return x.LoadBalancerName }).pop();
               }
               next();
           });
       },
       function(next) {
           // Create CloudWatch alarms, find SNS topic by name
           if (!req.alarmName) return next();
           aws.snsListTopics(function(err, topics) {
               var topic = new RegExp(alarmName, "i");
               topic = topics.filter(function(x) { return x.match(topic); }).pop();
               if (!topic) return next(err);
               req.alarms.push({ metric:"CPUUtilization",
                               threshold:self.getArgInt("-cpu-threshold", options, 80),
                               evaluationPeriods:self.getArgInt("-periods", options, 3),
                               alarm:topic });
               req.alarms.push({ metric:"NetworkOut",
                               threshold:self.getArgInt("-net-threshold", options, 8000000),
                               evaluationPeriods:self.getArgInt("-periods", options, 3),
                               alarm:topic });
               req.alarms.push({ metric:"StatusCheckFailed",
                               threshold: 1,
                               evaluationPeriods: 2,
                               statistic: "Maximum",
                               alarm:topic });
               next(err);
           });
       },
       function(next) {
           if (req.subnetId) return next();
           var params = req.vpcId ? { "Filter.1.Name": "vpc-id", "Filter.1.Value": req.vpcId } : {};
           aws.queryEC2("DescribeSubnets", params, function(err, rc) {
               subnets = lib.objGet(rc, "DescribeSubnetsResponse.subnetSet.item", { list: 1 });
               next(err);
           });
       },
       function(next) {
           if (req.subnetId) {
               subnets.push(req.subnetId);
           } else
           // Same amount of instances in each subnet
           if (self.isArg("-subnet-each", options)) {
               subnets = self.awsFilterSubnets(subnets, options.zone || aws.zone, self.getArg("-subnet-name", options, appName));
           } else
           // Split between all subnets
           if (self.isArg("-subnet-split", options)) {
               subnets = self.awsFilterSubnets(subnets, options.zone || aws.zone, self.getArg("-subnet-name", options, appName));
               if (count <= subnets.length) {
                   subnets = subnets.slice(0, count);
               } else {
                   var n = subnets.length;
                   for (var i = count - n; i > 0; i--) subnets.push(subnets[i % n]);
               }
               options.count = 1;
           } else {
               // Random subnet
               subnets = self.awsFilterSubnets(subnets, options.zone || aws.zone, self.getArg("-subnet-name", options, appName));
               subnets = [ subnets[lib.randomInt(0, subnets.length - 1)] ];
           }

           if (!subnets.length) return next("ERROR: subnet must be specified or discovered by filters");

           lib.forEachLimit(subnets, subnets.length, function(subnet, next2) {
               req.subnetId = subnet;
               logger.log("launchInstances:", req);
               if (core.isArg("-dry-run")) return next2();

               aws.ec2RunInstances(req, function(err, rc) {
                   if (err) return next2(err);
                   instances = instances.concat(lib.objGet(rc, "RunInstancesResponse.instancesSet.item", { list: 1 }));
                   next2();
               });
           }, next);
       },
       function(next) {
           if (instances.length) logger.log(instances.map(function(x) { return [ x.instanceId, x.privateIpAddress || "" ] }));
           if (!self.isArg("-wait", options)) return next();
           if (instances.length != 1) return next();
           aws.ec2WaitForInstance(instances[0].instanceId, "running",
                                  { waitTimeout: self.getArgInt("-wait-timeout", options, 600000),
                                    waitDelay: self.getArgInt("-wait-delay", options, 30000) },
                                  next);
       },
       ], callback);
}

// Delete an AMI with the snapshot
shell.cmdAwsLaunchInstances = function(options)
{
    this.launchInstances(options, function(err) {
        shell.exit(err);
    });
}

shell.cmdAwsShowImages = function(options)
{
    var filter = this.getArg("-filter");

    this.getSelfImages(filter || "*", function(err, images) {
        if (err) shell.exit(err);
        images.forEach(function(x) {
            console.log(x.imageId, x.name, x.imageState, x.description);
        });
        shell.exit();
    });
}

shell.cmdAwsShowAmazonImages = function(options)
{
    options.filter = this.getArg("-filter");
    options.rootdev = this.getArg("-rootdev");
    options.devtype = this.getArg("-devtype");
    options.arch = this.getArg("-arch");

    this.getAmazonImages(options, function(err, images) {
        if (err) shell.exit(err);
        images.forEach(function(x) {
            console.log(x.imageId, x.name, x.imageState, x.description);
        });
        shell.exit();
    });
}

shell.cmdAwsShowGroups = function(options)
{
    options.filter = this.getArg("-filter");
    options.name = this.getArg("-name");

    aws.ec2DescribeSecurityGroups(options, function(err, images) {
        images.forEach(function(x) {
            console.log(x.groupId, x.groupName, x.groupDescription);
        });
        shell.exit();
    });
}

// Delete an AMI with the snapshot
shell.cmdAwsDeleteImage = function(options)
{
    var self = this;
    var filter = this.getArg("-filter");
    if (!filter) shell.exit("-filter is required");
    var images = [];

    lib.series([
       function(next) {
           self.getSelfImages(filter, function(err, list) {
               if (!err) images = list;
               next(err);
           });
       },
       // Deregister existing image with the same name in the destination region
       function(next) {
           logger.log("DeregisterImage:", images);
           if (core.isArg("-dry-run")) return next();
           lib.forEachSeries(images, function(img, next2) {
               aws.ec2DeregisterImage(img.imageId, { snapshots: 1 }, next2);
           }, next);
       },
       ], function(err) {
           shell.exit(err);
       });
}

// Create an AMI from the current instance of the instance by id
shell.cmdAwsCreateImage = function(options)
{
    options.name = this.getArg("-name");
    options.descr = this.getArg("-descr");
    options.instanceId = this.getArg("-instance-id");
    options.noreboot = this.isArg("-no-reboot");
    options.reboot = this.isArg("-reboot");
    if (core.isArg("-dry-run")) return shell.exit(null, options);
    aws.ec2CreateImage(options, function(err) {
        shell.exit(err);
    });
}

// Reboot instances by run mode and/or other criteria
shell.cmdAwsRebootInstances = function(options)
{
    var self = this;
    var instances = [];
    var filter = this.getArg("-filter");
    if (!filter) shell.exit("-filter is required");

    lib.series([
       function(next) {
           var req = { "Filter.1.Name": "instance-state-name", "Filter.1.Value.1": "running", "Filter.2.Name": "tag:Name", "Filter.2.Value.1": filter };
           logger.debug("RebootInstances:", req)
           aws.queryEC2("DescribeInstances", req, function(err, rc) {
               instances = self.awsGetInstances(rc).map(function(x) { return x.instanceId });
               next(err);
           });
       },
       function(next) {
           if (!instances.length) shell.exit("No instances found");
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x });
           logger.log("RebootInstances:", req)
           if (core.isArg("-dry-run")) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
       ], function(err) {
           self.exit(err);
       });
}

// Terminate instances by run mode and/or other criteria
shell.cmdAwsTerminateInstances = function(options)
{
    var self = this;
    var instances = [];
    var filter = this.getArg("-filter");
    if (!filter) shell.exit("-filter is required");

    lib.series([
       function(next) {
           var req = { "Filter.1.Name": "instance-state-name", "Filter.1.Value.1": "running", "Filter.2.Name": "tag:Name", "Filter.2.Value.1": filter };
           logger.debug("terminateInstances:", req)
           aws.queryEC2("DescribeInstances", req, function(err, rc) {
               instances = self.awsGetInstances(rc).map(function(x) { return x.instanceId });
               next(err);
           });
       },
       function(next) {
           if (!instances.length) exit("No instances found");
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x });
           logger.log("TerminateInstances:", req)
           if (core.isArg("-dry-run")) return next();
           aws.queryEC2("TerminateInstances", req, next);
       },
       ], function(err) {
           self.exit(err);
       });
}

// Show running instances by run mode and/or other criteria
shell.cmdAwsShowInstances = function(options)
{
    var self = this;
    var instances = [];
    var filter = this.getArg("-filter");

    lib.series([
       function(next) {
           var req = { "Filter.1.Name": "tag:Name", "Filter.1.Value.1": filter || "*",
                       "Filter.2.Name": "instance-state-name", "Filter.2.Value.1": "running", }
           logger.debug("showInstances:", req);
           aws.queryEC2("DescribeInstances", req, function(err, rc) {
               instances = self.awsGetInstances(rc);
               next(err);
           });
       },
       function(next) {
           if (core.isArg("-show-ip")) {
               console.log(instances.map(function(x) { return x.privateIpAddress }).join(" "));
           } else {
               instances.forEach(function(x) { console.log(x.instanceId, x.privateIpAddress, x.publicIpAddress, x.name); });
           }
           next();
       },
       ], function(err) {
           self.exit(err);
       });
}

// Show ELB running instances
shell.cmdAwsShowElb = function(options)
{
    var self = this;
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var instances = [];
    var filter = core.getArg("-filter");

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               instances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 });
               next();
           });
       },
       function(next) {
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId });
           aws.queryEC2("DescribeInstances", req, function(err, rc) {
               var list = self.awsGetInstances(rc);
               list.forEach(function(row) {
                   instances.forEach(function(x) {
                       if (x.InstanceId == row.instanceId) x.name = row.name;
                   });
               });
               next(err);
           });
       },
       function(next) {
           // Show all instances or only for the specified version
           if (filter) {
               instances = instances.filter(function(x) { return (x.name && x.State == 'InService' && x.name.match(filter)); });
           }
           instances.forEach(function(x) {
               console.log(Object.keys(x).map(function(y) { return x[y] }).join(" | "));
           });
           next();
       },
       ], function(err) {
           self.exit(err);
       });
}

// Reboot instances in the ELB, one by one
shell.cmdAwsRebootElb = function(options)
{
    var self = this;
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var total = 0, instances = [];
    options.timeout = core.getArgInt("-timeout");
    options.interval = core.getArgInt("-interval");

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               instances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 }).filter(function(x) { return x.State == "InService" });
               total = instances.length;
               next();
           });
       },
       function(next) {
           // Reboot first half
           if (!instances.length) return next();
           var req = {};
           instances.splice(0, Math.floor(instances.length/2)).forEach(function(x, i) {
               req["InstanceId." + (i + 1)] = x.InstanceId;
           });
           logger.log("RebootELB:", elbName, "restarting:", req)
           if (core.isArg("-dry-run")) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
       function(next) {
           if (core.isArg("-dry-run")) return next();
           // Wait until one instance is out of service
           self.getElbCount(elbName, 1, total, options, next);
       },
       function(next) {
           if (core.isArg("-dry-run")) return next();
           // Wait until all instances in service again
           self.getElbCount(elbName, 0, total, options, next);
       },
       function(next) {
           // Reboot the rest
           if (!instances.length) return next();
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId });
           logger.log("RebootELB:", elbName, 'restarting:', req)
           if (core.isArg("-dry-run")) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
       ], function(err) {
           self.exit(err);
       });
}

// Deploy new version in the ELB, terminate the old version
shell.cmdAwsReplaceElb = function(options)
{
    var self = this;
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var total = 0, oldInstances = [], newInstances = [], oldInService = [];
    options.timeout = core.getArgInt("-timeout");
    options.interval = core.getArgInt("-interval");

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               oldInstances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 });
               oldInService = oldInstances.filter(function(x) { return x.State == "InService" });
               next();
           });
       },
       function(next) {
           logger.log("ReplaceELB:", elbName, 'running:', oldInstances)
           // Launch new instances
           self.launchInstances(options, next);
       },
       function(next) {
           newInstances = instances;
           if (core.isArg("-dry-run")) return next();
           // Wait until all instances are online
           self.getElbCount(elbName, 0, oldInService.length + newInstances.length, options, function(err, total, count) {
               if (!err && count != total) err = "Timeout waiting for instances";
               next(err);
           })
       },
       function(next) {
           // Terminate old instances
           if (!oldInstances.length) return next();
           var req = {};
           oldInstances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId });
           logger.log("ReplaceELB:", elbName, 'terminating:', req)
           if (core.isArg("-dry-run")) return next();
           aws.queryEC2("TerminateInstances", req, next);
       },
       ], function(err) {
           self.exit(err);
       });
}

// Open/close SSH access to the specified group for the current external IP address
shell.cmdAwsSetupSsh = function(options)
{
    var ip = "", groupId;
    var groupName = this.getArg("-group-name", options);
    if (!groupName) shell.exit("-group-name is required");

    lib.series([
       function(next) {
           getGroups(groupName, function(err, ids) {
               if (!err && ids.length) groupId = ids[0];
               next(err);
           });
       },
       function(next) {
           if (!groupId) return next("No group is found for", groupName);
           core.httpGet("http://checkip.amazonaws.com", function(err, params) {
               if (err || params.status != 200) return next(err || params.data || "Cannot determine IP address");
               ip = params.data.trim();
               next();
           });
       },
       function(next) {
           var req = { GroupId: groupId,
               "IpPermissions.1.IpProtocol": "tcp",
               "IpPermissions.1.FromPort": 22,
               "IpPermissions.1.ToPort": 22,
               "IpPermissions.1.IpRanges.1.CidrIp": ip + "/32" };
           logger.log(req);
           if (core.isArg("-dry-run")) return next();
           aws.queryEC2(core.isArg("-close") ? "RevokeSecurityGroupIngress" : "AuthorizeSecurityGroupIngress", req, next);
       },
       ], function(err) {
           shell.exit(err);
       });
}

// Launch an instance and setup it with provisioning script
shell.AwsSetupInstance = function(options)
{
    var opts = {};
    var file = core.getArg("-file");
    var cmd = core.getArg("-cmd");
    if (!file && !cmd) shell.exit("-file or -cmd is required");

    lib.series([
       function(next) {
           if (!file) return next();
           opts.userData = "#cloud-config\n" +
                   "write_files:\n" +
                   "  - encoding: b64\n" +
                   "    content: " + Buffer(lib.readFileSync(file)).toString("base64") + "\n" +
                   "    path: /tmp/cmd.sh\n" +
                   "    owner: ec2-user:root\n" +
                   "    permissions: '0755'\n" +
                   "runcmd:\n" +
                   "  - /tmp/cmd.sh\n";
           shell.launchInstances(opts, next);
       },
       function(next) {
           if (!cmd) return next();
           opts.userData = "#cloud-config\n" +
                   "runcmd:\n" +
                   "  - " + cmd + "\n";
           shell.launchInstances(opts, next);
       },
       ], function(err) {
           shell.exit(err);
       });
}

// Get file
shell.cmdAwsS3Get = function(options)
{
    var self = this;
    var query = this.getQuery();
    var file = core.getArg("-file");
    var uri = core.getArg("-path");
    query.file = file || uri.split("?")[0].split("/").pop();
    aws.s3GetFile(uri, query, function(err, data) {
        self.exit(err, data);
    });
}

// Put file
shell.cmdAwsS3Put = function(options)
{
    var self = this;
    var query = this.getQuery();
    var path = core.getArg("-path");
    var uri = core.getArg("-file");
    aws.s3PutFile(uri, file, query, function(err, data) {
        self.exit(err, data);
    });
}

// If executed as standalone script directly in the node
if (!module.parent) core.init({ role: "shell" }, function(err, opts) { shell.run(opts); });
