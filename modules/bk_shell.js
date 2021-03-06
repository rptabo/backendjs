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
var core = require(__dirname + '/../lib/core');
var lib = require(__dirname + '/../lib/lib');
var logger = require(__dirname + '/../lib/logger');
var db = require(__dirname + '/../lib/db');
var aws = require(__dirname + '/../lib/aws');
var ipc = require(__dirname + '/../lib/ipc');
var api = require(__dirname + '/../lib/api');
var os = require('os');

var shell = {
    name: "bk_shell",
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

// Return first available value for the given name, options first, then command arg and then default
shell.getArg = function(name, options, dflt)
{
    return decodeURIComponent(String((options && options[lib.toCamel(name.substr(1))]) || lib.getArg(name, dflt))).trim();
}

shell.getArgInt = function(name, options, dflt)
{
    return lib.toNumber(this.getArg(name, options, dflt));
}

shell.getArgList = function(name, options)
{
    var arg = options && options[lib.toCamel(name.substr(1))];
    if (arg) return Array.isArray(arg) ? arg : [ arg ];
    var list = [];
    for (var i = process.argv.length - 1; i > 1; i -= 2) {
        if (process.argv[i - 1] == name) list.push(process.argv[i]);
    }
    return list;
}

shell.isArg = function(name, options)
{
    return (options && typeof options[lib.toCamel(name.substr(1))] != "undefined") || lib.isArg(name);
}

// Start REPL shell or execute any subcommand if specified in the command line.
// A subcommand may return special string to indicate how to treat the flow:
// - stop - stop processing commands and create REPL
// - continue - do not exit and continue processing other commands or end with REPL
// - all other values will result in returning from the run assuming the command will decide what to do, exit or continue running, no REPL is created
shell.run = function(options)
{
    process.title = core.name + ": shell";

    logger.debug('startShell:', process.argv);

    core.runMethods("configureShell", options, function(err) {
        if (options.done) exit();

        ipc.initServer();

        for (var i = 1; i < process.argv.length; i++) {
            if (process.argv[i][0] != '-') continue;
            var name = lib.toCamel("cmd" + process.argv[i]);
            if (typeof shell[name] != "function") continue;
            var rc = shell[name](options);
            if (rc == "stop") break;
            if (rc == "continue") continue;
            return;
        }
        core.createRepl({ file: core.repl.file });
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

// To be used in the tests, this function takes the following arguments:
//
// assert(next, err, ....)
//  - next is a callback to be called after printing error condition if any, it takes err as its argument
//  - err - an error object from the most recent operation, can be null/undefined or any value that results in Javascript "true" evaluation
//    up to the caller, assertion happens if an err is given or this value is true
//  - all other arguments are printed in case of error or result being false
//
//  NOTES:
//   - In forever mode `-test-forever` any error is ignored and not reported
//   - if `tests.test.delay` is set it will be used to delay calling the next callback and reset, this is for
//     one time delays.
//
// Example
//
//          function(next) {
//              db.get("bk_account", { id: "123" }, function(err, row) {
//                  tests.assert(next, err || !row || row.id != "123", "Record not found", row)
//              });
//          }
shell.assert = function(next, err)
{
    if (this.test.forever) return next();

    if (err) {
        var args = [ util.isError(err) ? err : lib.isObject(err) ? lib.objDescr(err) : ("TEST ASSERTION: " + lib.objDescr(arguments[2])) ];
        for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
        logger.error.apply(logger, args);
        err = args[0];
    }
    setTimeout(next.bind(null, err), this.test.timeout || this.test.delay || 0);
    this.test.delay = 0;
}

// Run the test function which is defined in the tests module, all arguments will be taken from the options or the command line. Options
// use the same names as command line arguments without preceeding `test-` prefix.
//
// The common command line arguments that supported:
// - -test-run - name of the function to run
// - -test-workers - number of workers to run the test at the same time
// - -test-delay - number of milliseconds before starting worker processes, default is 500ms
// - -test-timeout - number of milliseconds between test steps, i.e. between invocations of the check
// - -test-interval - number of milliseconds between iterations
// - -test-iterations - how many times to run this test function, default is 1
// - -test-forever - run forever without reporting any errors, for performance testing
// - -test-file - a javascript file to be loaded with additional tests
//
// All other common command line arguments are used normally, like -db-pool to specify which db to use.
//
// After finish or in case of error the process exits if no callback is given.
//
// Example, store it in tests/tests.js:
//
//          var bkjs = require("backendjs");
//          var tests = bkjs.core.modules.tests;
//
//          tests.test_mytest = function(next) {
//             bkjs.db.get("bk_account", { id: "123" }, function(err, row) {
//                 tests.assert(next, err || !row || row.id != "123", "Record not found", row)
//             });
//          }
//
//          # bksh -test-run mytest
//
// Custom tests:
//
//   - create a user for backend testing, if the API does not require authentication skip this step:
//
//           ./app.sh -shell -account-add login testuser secret testpw
//
//   - configure global backend credentials
//
//           echo "backend-login=testuser" >> etc/config.local
//           echo "backend-secret=testpw" >> etc/config.local
//
//   - to start a test command in the shell using local ./tests.js
//
//         ./app.sh -shell -test-run account
//
//   - to start a test command in the shell using custom file with tests
//
//         ./app.sh -shell -test-run api -test-file tests/api.js
//
shell.cmdTestRun = function(options)
{
    var tests = shell;
    core.addModule("tests", tests);

    tests.test = { role: cluster.isMaster ? "master" : "worker", iterations: 0, stime: Date.now() };
    tests.test.countdown = tests.getArgInt("-test-iterations", options, 1);
    tests.test.forever = tests.getArgInt("-test-forever", options, 0);
    tests.test.timeout = tests.getArgInt("-test-timeout", options, 0);
    tests.test.interval = tests.getArgInt("-test-interval", options, 0);
    tests.test.keepmaster = tests.getArgInt("-test-keepmaster", options, 0);
    tests.test.workers = tests.getArgInt("-test-workers", options, 0);
    tests.test.workers_delay = tests.getArgInt("-test-workers-delay", options, 500);
    tests.test.cmd = tests.getArg("-test-run", options);
    tests.test.file = tests.getArg("-test-file", options, "tests/tests.js");
    if (tests.test.file) {
        if (fs.existsSync(tests.test.file)) require(tests.test.file); else
        if (fs.existsSync(core.cwd + "/" + tests.test.file)) require(core.cwd + "/" + tests.test.file);
        if (fs.existsSync(__dirname + "/../" + tests.test.file)) require(__dirname + "/../" + tests.test.file);
    }

    var cmds = lib.strSplit(tests.test.cmd);
    for (var i in cmds) {
        if (!this['test_' + cmds[i]]) {
            var cmds = Object.keys(this).filter(function(x) { return x.substr(0, 5) == "test_" && typeof tests[x] == "function" }).map(function(x) { return x.substr(5) }).join(", ");
            logger.log(tests.name, "usage: ", process.argv[0], process.argv[1], "-test-run", "CMD", "where CMD is one of: ", cmds);
            process.exit(1);
        }
    }

    if (cluster.isMaster) {
        setTimeout(function() { for (var i = 0; i < tests.test.workers; i++) cluster.fork(); }, tests.test.workers_delay);
        cluster.on("exit", function(worker) {
            if (!Object.keys(cluster.workers).length && !tests.test.forever && !tests.test.keepmaster) process.exit(0);
        });
    }

    logger.log("tests started:", cluster.isMaster ? "master" : "worker", 'cmd:', tests.test.cmd, 'db-pool:', core.modules.db.pool);

    lib.whilst(
        function () { return tests.test.countdown > 0 || tests.test.forever || options.running; },
        function (next) {
            tests.test.countdown--;
            lib.forEachSeries(cmds, function(cmd, next2) {
                tests["test_" + cmd](function(err) {
                    tests.test.iterations++;
                    if (tests.test.forever) err = null;
                    setTimeout(next2.bind(null, err), tests.test.interval);
                });
            }, next);
        },
        function(err) {
            tests.test.etime = Date.now();
            if (err) {
                logger.error("FAILED:", tests.test.role, 'cmd:', tests.test.cmd, err);
                process.exit(1);
            }
            logger.log("SUCCESS:", tests.test.role, 'cmd:', tests.test.cmd, 'db-pool:', core.modules.db.pool, 'time:', tests.test.etime - tests.test.stime, "ms");
            process.exit(0);
        });
}

// Run API server inside the shell
shell.cmdRunApi = function(options)
{
    api.init();
    return "continue";
}

// Show account records by id or login
shell.cmdAccountGet = function(options)
{
    lib.forEachSeries(process.argv.slice(2), function(id, next) {
        if (id.match(/^[-\/]/)) return next();
        db.get("bk_account", { id: id }, function(err, user) {
            if (user) {
                db.get("bk_auth", { login: user.login }, function(err, auth) {
                    user.bk_auth = auth;
                    console.log(user);
                    next();
                });
            } else {
                db.get("bk_auth", { login: id }, function(err, auth) {
                    if (!auth) return next();
                    db.get("bk_account", { id: auth.id }, function(err, user) {
                        if (!user) {
                            console.log(auth);
                        } else {
                            user.bk_auth = auth;
                            console.log(user);
                        }
                        next();
                    });
                });
            }
        });
    }, function(err) {
        shell.exit(err);
    });
}

// Add a user
shell.cmdAccountAdd = function(options)
{
    if (!core.modules.bk_account) exit("accounts module not loaded");
    var query = this.getQuery();
    var opts = api.getOptions({ query: this.getArgs(), options: { path: ["", "", ""], ops: {} } });
    if (lib.isArg("-scramble")) opts.scramble = 1;
    if (query.login && !query.name) query.name = query.login;
    core.modules.bk_account.addAccount({ query: query, account: { type: 'admin' } }, opts, function(err, data) {
        shell.exit(err, data);
    });
}

// Delete a user and all its history according to the options
shell.cmdAccountUpdate = function(options)
{
    if (!core.modules.bk_account) this.exit("accounts module not loaded");
    var query = this.getQuery();
    var opts = api.getOptions({ query: this.getArgs(), options: { path: ["", "", ""], ops: {} } });
    if (lib.isArg("-scramble")) opts.scramble = 1;
    this.getUser(query, function(row) {
        core.modules.bk_account.updateAccount({ account: row, query: query }, opts, function(err, data) {
            shell.exit(err, data);
        });
    });
}

// Delete a user and all its history according to the options
shell.cmdAccountDel = function(options)
{
    if (!core.modules.bk_account) this.exit("accounts module not loaded");
    var query = this.getQuery();
    var opts = api.getOptions({ query: this.getArgs(), options: { path: ["", "", ""], ops: {} } });
    for (var i = 1; i < process.argv.length - 1; i += 2) {
        if (process.argv[i] == "-keep") opts["keep_" + process.argv[i + 1]] = 1;
    }
    this.getUser(query, function(row) {
        opts.id = row.id;
        core.modules.bk_account.deleteAccount({ account: row, options: opts }, function(err) {
            shell.exit(err);
        });
    });
}

// Update location
shell.cmdLocationPut = function(options)
{
    if (!core.modules.bk_location) this.exit("locations module not loaded");
    var query = this.getQuery();
    this.getUser(query, function(row) {
        core.modules.bk_location.putLocation({ account: row, query: query }, {}, function(err, data) {
            shell.exit(err, data);
        });
    });
}

// Run logwatcher and exit
shell.cmdLogWatch = function(options)
{
    core.watchLogs(function(err) {
        shell.exit(err);
    });
}

// Show all config parameters
shell.cmdDbGetConfig = function(options)
{
    var opts = this.getQuery();
    var sep = lib.getArg("-separator", "=");
    var fmt = lib.getArg("-format");
    db.initConfig(opts, function(err, data) {
        if (fmt == "text") {
            for (var i = 0; i < data.length; i += 2) console.log(data[i].substr(1) + (sep) + data[i + 1]);
        } else
        if (fmt == "args") {
            var str = "";
            for (var i = 0; i < data.length; i += 2) str += "-" + data[i].substr(1) + " '" + (data[i + 1] || 1) + "' ";
            console.log(str);
        } else {
            console.log(JSON.stringify(data));
        }
        shell.exit(err);
    });
}

// Show all tables
shell.cmdDbTables = function(options)
{
    var sep = lib.getArg("-separator", "\n");
    var tables = db.getPoolTables(db.pool, { names: 1 });
    console.log(tables.join(sep));
    this.exit();
}

// Show record that match the search criteria, return up to `-count N` records
shell.cmdDbSelect = function(options)
{
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    var sep = lib.getArg("-separator", "!");
    var fmt = lib.getArg("-format");
    var cols = Object.keys(db.getColumns(table))
    db.select(table, query, opts, function(err, data) {
        if (data && data.length) {
            if (fmt == "text") {
                data.forEach(function(x) { console.log((cols || Object.keys(x)).map(function(y) { return x[y] }).join(sep)) });
            } else {
                data.forEach(function(x) { console.log(JSON.stringify(x)) });
            }
        }
        shell.exit(err);
    });
}

// Show all records that match search criteria
shell.cmdDbScan = function(options)
{
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    var sep = lib.getArg("-separator", "!");
    var fmt = lib.getArg("-format");
    var cols = Object.keys(db.getColumns(table));
    db.scan(table, query, opts, function(row, next) {
        if (fmt == "text") {
            console.log((cols || Object.keys(row)).map(function(y) { return row[y] }).join(sep));
        } else {
            console.log(JSON.stringify(row));
        }
        next();
    }, function(err) {
        shell.exit(err);
    });
}

// Save all tables to the specified directory or the server home
shell.cmdDbBackup = function(options)
{
    var opts = this.getArgs();
    var query = this.getQuery();
    var root = lib.getArg("-path");
    var filter = lib.getArg("-filter");
    var tables = lib.strSplit(lib.getArg("-tables"));
    var skip = lib.strSplit(lib.getArg("-skip"));
    var incremental = lib.getArgInt("-incremental");
    var progress = lib.getArgInt("-progress");
    opts.fullscan = 1;
    if (!opts.useCapacity) opts.useCapacity = "read";
    if (!opts.factorCapacity) opts.factorCapacity = 0.25;
    if (!tables.length) tables = db.getPoolTables(db.pool, { names: 1 });
    lib.forEachSeries(tables, function(table, next) {
        if (skip.indexOf(table) > -1) return next();
        var file = path.join(root, table +  ".json");
        if (incremental > 0) {
            var lines = lib.readFileSync(file, { offset: -incremental, list: "\n" });
            for (var i = lines.length - 1; i >= 0; i--) {
                var line = lib.jsonParse(lines[i]);
                if (line) opts.start = db.getSearchQuery(table, line);
                if (opts.start && Object.keys(opts.start).length) break;
                delete opts.start;
            }
        } else {
            delete opts.start;
            fs.writeFileSync(file, "");
        }
        db.scan(table, query, opts, function(row, next2) {
            if (filter && app[filter]) app[filter](table, row);
            fs.appendFileSync(file, JSON.stringify(row) + "\n");
            if (progress && opts.nrows % progress == 0) logger.info("cmdDbBackup:", table, opts.nrows, "records");
            next2();
        }, function() {
            next();
        });
    }, function(err) {
        logger.info("dbBackup:", root, tables, opts);
        shell.exit(err);
    });
}

// Restore tables
shell.cmdDbRestore = function(options)
{
    var opts = this.getArgs();
    var root = lib.getArg("-path");
    var filter = lib.getArg("-filter");
    var mapping = lib.strSplit(lib.getArg("-mapping"));
    var tables = lib.strSplit(lib.getArg("-tables"));
    var skip = lib.strSplit(lib.getArg("-skip"));
    var files = lib.findFileSync(root, { depth: 1, types: "f", include: /\.json$/ });
    var progress = lib.getArgInt("-progress");
    if (lib.isArg("-drop")) opts.drop = 1;
    if (lib.isArg("-continue")) opts.continue = 1;
    opts.errors = 0;
    lib.forEachSeries(files, function(file, next3) {
        var table = path.basename(file, ".json");
        if (tables.length && tables.indexOf(table) == -1) return next3();
        if (skip.indexOf(table) > -1) return next3();
        var cap = db.getCapacity(table);
        opts.readCapacity = cap.readCapacity;
        opts.writeCapacity = cap.writeCapacity;
        opts.upsert = true;
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
                db.create(table, db.tables[table], opts, next);
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
                    if (!line) return next2();
                    var row = lib.jsonParse(line, { logger: "error" });
                    if (!row) return next2(opts.continue ? null : "ERROR: parse error, line: " + opts.nlines);
                    if (filter && app[filter]) app[filter](table, row);
                    for (var i = 0; i < mapping.length-1; i+= 2) {
                        row[mapping[i+1]] = row[mapping[i]];
                        delete row[mapping[i]];
                    }
                    if (progress && opts.nlines % progress == 0) logger.info("cmdDbRestore:", table, opts.nlines, "records");
                    db.update(table, row, opts, function(err) {
                        if (err && !opts.continue) return next2(err);
                        if (err) opts.errors++;
                        db.checkCapacity(cap, next2);
                    });
                }, next);
            }], next3);
    }, function(err) {
        logger.info("dbRestore:", root, tables || files, opts);
        if (!opts.noexit) shell.exit(err);
    });
}

// Put config entry
shell.cmdDbGet = function(options)
{
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    var sep = lib.getArg("-separator", "!");
    var fmt = lib.getArg("-format");
    var cols = Object.keys(db.getColumns(table))
    db.get(table, query, opts, function(err, data) {
        if (data) {
            if (fmt == "text") {
                console.log((cols || Object.keys(data)).map(function(y) { return x[y] }).join(sep))
            } else {
                console.log(JSON.stringify(data));
            }
        }
        shell.exit(err);
    });
}

// Put a record
shell.cmdDbPut = function(options)
{
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    db.put(table, query, opts, function(err, data) {
        shell.exit(err);
    });
}

// Delete a record
shell.cmdDbDel = function(options)
{
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    db.del(table, query, opts, function(err, data) {
        shell.exit(err);
    });
}

// Delete all records
shell.cmdDbDelAll = function(options)
{
    var query = this.getQuery();
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    db.delAll(table, query, opts, function(err, data) {
        shell.exit(err);
    });
}

// Drop a table
shell.cmdDbDrop = function(options)
{
    var opts = this.getArgs();
    var table = lib.getArg("-table");
    db.drop(table, opts, function(err, data) {
        shell.exit(err);
    });
}

// Send API request
shell.cmdSendRequest = function(options)
{
    var query = this.getQuery();
    var url = lib.getArg("-url");
    var id = lib.getArg("-id");
    var login = lib.getArg("-login");
    this.getUser({ id: id, login: login }, function(row) {
        core.sendRequest({ url: url, login: row.login, secret: row.secret, query: query }, function(err, params) {
            shell.exit(err, params.obj);
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
    return subnets.filter(function(x) {
        if (zone && zone != x.availablityZone && zone != x.availabilityZone.split("-").pop()) return 0;
        return name ? shell.awsCheckTags(x, name) : 1;
    }).map(function(x) {
        return x.subnetId;
    });
}

// Retrieve my AMIs for the given name pattern
shell.awsGetSelfImages = function(name, callback)
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

// Return an image that matches given app name latest version
shell.awsSearchImage = function(filter, appName, callback)
{
    var img;

    this.awsGetSelfImages(filter, function(err, rc) {
        if (err) return callback(err);

        // Give preference to the images with the same app name
        if (rc.length) {
            var rx = new RegExp("^" + appName, "i");
            for (var i = 0; i < rc.length && !img; i++) {
                if (rc[i].name.match(rx)) img = rc[i];
            }
            if (!img) img = rc[0];
        }
        callback(err, img);
    });
}

// Return Amazon AMIs for the current region, HVM type only
shell.awsGetAmazonImages = function(options, callback)
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
    if (lib.isArg("-dry-run")) {
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

shell.awsGetUserData = function(options)
{
    var userData = this.getArg("-user-data", options);
    if (!userData || userData.match(/^#cloud-config/)) {
        var cloudInit = "";
        var runCmd = this.getArgList("-cloudinit-cmd", options);
        if (runCmd.length) cloudInit += "runcmd:\n" + runCmd.map(function(x) { return " - " + x }).join("\n") + "\n";
        var hostName = this.getArg("-host-name", options);
        if (hostName) cloudInit += "hostname: " + hostName + "\n";
        var user = this.getArg("-user", options, "ec2-user");
        var bkjsCmd = this.getArgList("-bkjs-cmd", options);
        if (bkjsCmd.length) cloudInit += "runcmd:\n" + bkjsCmd.map(function(x) { return " - /home/" + user + "/bin/bkjs " + x }).join("\n") + "\n";
        if (cloudInit) userData = !userData ? "#cloud-config\n" + cloudInit : "\n" + cloudInit;
    }
    return userData;
}

// Launch instances by run mode and/or other criteria
shell.launchInstances = function(options, callback)
{
    var subnets = [], instances = [];
    var appName = this.getArg("-app-name", options, core.appName);
    var appVersion = this.getArg("-app-version", options, core.appVersion);

    var req = {
        name: this.getArg("-name", options, appName + "-" + appVersion),
        count: this.getArgInt("-count", options, 1),
        vpcId: this.getArg("-vpc-id", options, aws.vpcId),
        instanceType: this.getArg("-instance-type", options, aws.instanceType),
        imageId: this.getArg("-image-id", options, aws.imageId),
        subnetId: this.getArg("-subnet-id", options, aws.subnetId),
        keyName: this.getArg("-key-name", options, aws.keyName) || appName,
        elbName: this.getArg("-elb-name", options, aws.elbName),
        elasticIp: this.getArg("-elastic-ip", options),
        publicIp: this.isArg("-public-ip", options),
        groupId: this.getArg("-group-id", options, aws.groupId),
        iamProfile: this.getArg("-iam-profile", options, aws.iamProfile) || appName,
        availabilityZone: this.getArg("-availability-zone"),
        terminate: this.isArg("-no-terminate", options) ? 0 : 1,
        alarms: [],
        data: this.awsGetUserData(options),
    };
    logger.debug("launchInstances:", req);

    lib.series([
       function(next) {
           if (req.imageId) return next();
           var imageName = shell.getArg("-image-name", options, '*');
           shell.awsSearchImage(imageName, appName, function(err, ami) {
               req.imageId = ami.imageId;
               next(err ? err : !req.imageId ? "ERROR: AMI must be specified or discovered by filters" : null);
           });
       },
       function(next) {
           if (req.groupId) return next();
           var filter = shell.getArg("-group-name", options, appName + "|^default$");
           aws.ec2DescribeSecurityGroups({ filter: filter }, function(err, rc) {
               if (!err) req.groupId = rc.map(function(x) { return x.groupId });
               next(err);
           });
       },
       function(next) {
           // Verify load balancer name
           if (shell.isArg("-no-elb", options)) return next();
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
           var alarmName = shell.getArg("-alarm-name", options);
           if (!alarmName) return next();
           aws.snsListTopics(function(err, topics) {
               var topic = new RegExp(alarmName, "i");
               topic = topics.filter(function(x) { return x.match(topic); }).pop();
               if (!topic) return next(err);
               req.alarms.push({ metric:"CPUUtilization",
                               threshold: shell.getArgInt("-cpu-threshold", options, 80),
                               evaluationPeriods: shell.getArgInt("-periods", options, 3),
                               alarm:topic });
               req.alarms.push({ metric:"NetworkOut",
                               threshold: shell.getArgInt("-net-threshold", options, 10000000),
                               evaluationPeriods: shell.getArgInt("-periods", options, 3),
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
           var zone = shell.getArg("-zone");
           if (req.subnetId) {
               subnets.push(req.subnetId);
           } else
           // Same amount of instances in each subnet
           if (shell.isArg("-subnet-each", options)) {
               subnets = shell.awsFilterSubnets(subnets, zone, shell.getArg("-subnet-name", options));
           } else
           // Split between all subnets
           if (shell.isArg("-subnet-split", options)) {
               subnets = shell.awsFilterSubnets(subnets, zone, shell.getArg("-subnet-name", options));
               if (count <= subnets.length) {
                   subnets = subnets.slice(0, count);
               } else {
                   var n = subnets.length;
                   for (var i = count - n; i > 0; i--) subnets.push(subnets[i % n]);
               }
               options.count = 1;
           } else {
               // Random subnet
               subnets = shell.awsFilterSubnets(subnets, zone, shell.getArg("-subnet-name", options));
               lib.shuffle(subnets);
               subnets = subnets.slice(0, 1);
           }
           if (!subnets.length) return next("ERROR: subnet must be specified or discovered by filters");

           lib.forEachLimit(subnets, subnets.length, function(subnet, next2) {
               req.subnetId = subnet;
               logger.log("launchInstances:", req);
               if (lib.isArg("-dry-run")) return next2();

               aws.ec2RunInstances(req, function(err, rc) {
                   if (err) return next2(err);
                   instances = instances.concat(lib.objGet(rc, "RunInstancesResponse.instancesSet.item", { list: 1 }));
                   next2();
               });
           }, next);
       },
       function(next) {
           if (instances.length) logger.log(instances.map(function(x) { return [ x.instanceId, x.privateIpAddress || "", x.publicIpAddress || "" ] }));
           if (!shell.isArg("-wait", options)) return next();
           if (instances.length != 1) return next();
           aws.ec2WaitForInstance(instances[0].instanceId, "running",
                                  { waitTimeout: shell.getArgInt("-wait-timeout", options, 600000),
                                    waitDelay: shell.getArgInt("-wait-delay", options, 30000) },
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

    this.awsGetSelfImages(filter || "*", function(err, images) {
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

    this.awsGetAmazonImages(options, function(err, images) {
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
    var filter = this.getArg("-filter");
    if (!filter) shell.exit("-filter is required");
    var images = [];

    lib.series([
       function(next) {
           shell.awsGetSelfImages(filter, function(err, list) {
               if (!err) images = list;
               next(err);
           });
       },
       // Deregister existing image with the same name in the destination region
       function(next) {
           logger.log("DeregisterImage:", images);
           if (lib.isArg("-dry-run")) return next();
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
    options.interval = lib.getArgInt("-interval", 5000);
    if (lib.isArg("-dry-run")) return shell.exit(null, options);
    var imgId;
    lib.series([
       function(next) {
           aws.ec2CreateImage(options, function(err, rc) {
               imgId = lib.objGet(rc, "CreateImageResponse.imageId");
               next(err);
           });
       },
       function(next) {
           if (!imgId || !shell.isArg("-wait")) return next();
           var running = 1, expires = Date.now() + lib.getArgInt("-timeout", 300000);
           lib.doWhilst(
             function(next) {
                 aws.queryEC2("DescribeImages", { "ImageId.1": imgId }, function(err, rc) {
                     if (err) return next(err);
                     var images = lib.objGet(rc, "DescribeImagesResponse.imagesSet.item", { list: 1 });
                     running = (images.length && images[0].imageState == "available") || Date.now() > expires ? 0 : 1;
                     setTimeout(next, running ? options.interval : 0);
                 });
             },
             function() {
                 return running;
             },
             function(err) {
                 next(err);
             });
       },
    ], function(err) {
        if (imgId) console.log(imgId);
        shell.exit(err);
    });
}

// Reboot instances by run mode and/or other criteria
shell.cmdAwsRebootInstances = function(options)
{
    var instances = [];
    var filter = this.getArg("-filter");
    if (!filter) shell.exit("-filter is required");

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               instances = list.map(function(x) { return x.instanceId });
               next(err);
           });
       },
       function(next) {
           if (!instances.length) shell.exit("No instances found");
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x });
           logger.log("RebootInstances:", req)
           if (lib.isArg("-dry-run")) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Terminate instances by run mode and/or other criteria
shell.cmdAwsTerminateInstances = function(options)
{
    var instances = [];
    var filter = this.getArg("-filter");
    if (!filter) shell.exit("-filter is required");

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               instances = list.map(function(x) { return x.instanceId });
               next(err);
           });
       },
       function(next) {
           if (!instances.length) exit("No instances found");
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x });
           logger.log("TerminateInstances:", req)
           if (lib.isArg("-dry-run")) return next();
           aws.queryEC2("TerminateInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Show running instances by run mode and/or other criteria
shell.cmdAwsShowInstances = function(options)
{
    var instances = [];
    var filter = this.getArg("-filter");
    var col = this.getArg("-col");

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               instances = list;
               next(err);
           });
       },
       function(next) {
           logger.debug("showInstances:", instances);
           if (col) {
               var map = { priv: "privateIpAddress", ip: "ipAddress", id: "instanceId", name: "name", key: "keyName" }
               console.log(instances.map(function(x) { return lib.objDescr(x[map[col] || col]) }).join(" "));
           } else {
               instances.forEach(function(x) { console.log(x.instanceId, x.subnetId, x.privateIpAddress, x.ipAddress, x.name, x.keyName); });
           }
           next();
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Update a Route53 record with IP/names of all instances specified by the filter
shell.cmdAwsSetRoute53 = function(options)
{
    var name = this.getArg("-name");
    if (!name) shell.exit("ERROR: -name must be specified and must be a full host name")
    var filter = this.getArg("-filter");
    var type = this.getArg("-type", options, "A");
    var ttl = this.getArg("-ttl");
    var public = this.isArg("-public");
    var values = [];

    lib.series([
       function(next) {
           var req = { stateName: "running", tagName: filter };
           aws.ec2DescribeInstances(req, function(err, list) {
               values = list.map(function(x) {
                   switch (type) {
                   case "A":
                       return public ? x.ipAddress || x.publicIpAddress : x.privateIpAddress;
                   case "CNAME":
                       return public ? x.publicDnsName : x.privateDnsName;
                   }
               }).filter(function(x) { return x });
               next(err);
           });
       },
       function(next) {
           if (!values.length) return next();
           logger.log("setRoute53:", name, type, values);
           if (lib.isArg("-dry-run")) return next();
           aws.route53Change({ name: name, type: type, ttl: ttl, value: values }, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Show ELB running instances
shell.cmdAwsShowElb = function(options)
{
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var instances = [];
    var filter = lib.getArg("-filter");

    lib.series([
       function(next) {
           aws.queryELB("DescribeInstanceHealth", { LoadBalancerName: elbName }, function(err, rc) {
               if (err) return next(err);
               instances = lib.objGet(rc, "DescribeInstanceHealthResponse.DescribeInstanceHealthResult.InstanceStates.member", { list: 1 });
               next();
           });
       },
       function(next) {
           var req = { instanceId: instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId }) };
           aws.ec2DescribeInstances(req, function(err, list) {
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
        shell.exit(err);
    });
}

// Reboot instances in the ELB, one by one
shell.cmdAwsRebootElb = function(options)
{
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var total = 0, instances = [];
    options.timeout = lib.getArgInt("-timeout");
    options.interval = lib.getArgInt("-interval");

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
           if (lib.isArg("-dry-run")) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
       function(next) {
           if (lib.isArg("-dry-run")) return next();
           // Wait until one instance is out of service
           shell.getElbCount(elbName, 1, total, options, next);
       },
       function(next) {
           if (lib.isArg("-dry-run")) return next();
           // Wait until all instances in service again
           shell.getElbCount(elbName, 0, total, options, next);
       },
       function(next) {
           // Reboot the rest
           if (!instances.length) return next();
           var req = {};
           instances.forEach(function(x, i) { req["InstanceId." + (i + 1)] = x.InstanceId });
           logger.log("RebootELB:", elbName, 'restarting:', req)
           if (lib.isArg("-dry-run")) return next();
           aws.queryEC2("RebootInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Deploy new version in the ELB, terminate the old version
shell.cmdAwsReplaceElb = function(options)
{
    var elbName = this.getArg("-elb-name", options, aws.elbName);
    if (!elbName) shell.exit("ERROR: -aws-elb-name or -elb-name must be specified")
    var total = 0, oldInstances = [], newInstances = [], oldInService = [];
    options.timeout = lib.getArgInt("-timeout");
    options.interval = lib.getArgInt("-interval");

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
           shell.launchInstances(options, next);
       },
       function(next) {
           newInstances = instances;
           if (lib.isArg("-dry-run")) return next();
           // Wait until all instances are online
           shell.getElbCount(elbName, 0, oldInService.length + newInstances.length, options, function(err, total, count) {
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
           if (lib.isArg("-dry-run")) return next();
           aws.queryEC2("TerminateInstances", req, next);
       },
    ], function(err) {
        shell.exit(err);
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
           if (lib.isArg("-dry-run")) return next();
           aws.queryEC2(lib.isArg("-close") ? "RevokeSecurityGroupIngress" : "AuthorizeSecurityGroupIngress", req, next);
       },
    ], function(err) {
        shell.exit(err);
    });
}

// Launch an instance and setup it with provisioning script
shell.AwsSetupInstance = function(options)
{
    var opts = {};
    var file = lib.getArg("-file");
    var cmd = lib.getArg("-cmd");
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
                   "  - [ /tmp/cmd.sh ]\n" +
                   "  - [ rm, -f, /tmp/cmd.sh ]\n";
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
    var query = this.getQuery();
    var file = lib.getArg("-file");
    var uri = lib.getArg("-path");
    query.file = file || uri.split("?")[0].split("/").pop();
    aws.s3GetFile(uri, query, function(err, data) {
        shell.exit(err, data);
    });
}

// Put file
shell.cmdAwsS3Put = function(options)
{
    var query = this.getQuery();
    var path = lib.getArg("-path");
    var uri = lib.getArg("-file");
    aws.s3PutFile(uri, file, query, function(err, data) {
        shell.exit(err, data);
    });
}

shell.cmdAwsCreateLaunchConfig = function(options)
{
    var appName = this.getArg("-app-name", options, core.appName);
    var appVersion = this.getArg("-app-version", options, core.appVersion);
    var configName = shell.getArg("-config-name", options);

    var config, image, instance, groups;
    var req = {
        LaunchConfigurationName: this.getArg("-name", options),
        InstanceType: this.getArg("-instance-type", options, aws.instanceType),
        ImageId: this.getArg("-image-id", options, aws.imageId),
        InstanceId: this.getArg("-instance-id", options),
        KeyName: this.getArg("-key-name", options, aws.keyName),
        IamInstanceProfile: this.getArg("-iam-profile", options, aws.iamProfile),
        AssociatePublicIpAddress: this.getArg("-public-ip"),
        "SecurityGroups.member.1": this.getArg("-group-id", options, aws.groupId),
    };
    var d = this.getArg("-device", options).match(/^([a-z0-9\/]+):([a-z0-9]+):([0-9]+)$/);
    if (d) {
        req['BlockDeviceMappings.member.1.DeviceName'] = d[1];
        req['BlockDeviceMappings.member.1.Ebs.VolumeType'] = d[2];
        req['BlockDeviceMappings.member.1.Ebs.VolumeSize'] = d[3];
    }
    var udata = this.awsGetUserData(options);
    if (udata) req.UserData = new Buffer(udata).toString("base64");

    lib.series([
       function(next) {
           if (!configName) return next();
           aws.queryAS("DescribeLaunchConfigurations", {}, function(err, rc) {
               if (err) return next(err);
               var configs = lib.objGet(rc, "DescribeLaunchConfigurationsResponse.DescribeLaunchConfigurationsResult.LaunchConfigurations.member", { list: 1 });
               // Sort by version in descending order, assume name-N.N.N naming convention
               configs.sort(function(a, b) {
                   var n1 = a.LaunchConfigurationName.split(/[ -]/);
                   n1[1] = lib.toVersion(n1[1]);
                   var n2 = b.LaunchConfigurationName.split(/[ -]/);
                   n2[1] = lib.toVersion(n2[1]);
                   return n1[0] > n2[0] ? -1 : n1[0] < n2[0] ? 1 : n2[1] - n1[1];
               });
               var rx = new RegExp("^" + configName + "-", "i");
               for (var i in configs) {
                   if (rx.test(configs[i].LaunchConfigurationName)) {
                       config = configs[i];
                       break;
                   }
               }
               next(err);
           });
       },
       function(next) {
           if (req.InstanceId) return next();
           var filter = shell.getArg("-instance-name");
           if (!filter) return next();
           var q = { tagName: filter, stateName: "running" };
           aws.ec2DescribeInstances(q, function(err, list) {
               instance = list[0];
               if (instance) req.InstanceId = instance.instanceId;
               next(err);
           });
       },
       function(next) {
           if (req.ImageId) return next();
           var filter = shell.getArg("-image-name", options, '*');
           shell.awsSearchImage(filter, appName, function(err, rc) {
               image = rc;
               next(err ? err : !image ? "ERROR: AMI must be specified or discovered by filters" : null);
           });
       },
       function(next) {
           if (req["SecurityGroups.member.1"]) return next();
           var filter = shell.getArg("-group-name", options, appName + "|^default$");
           aws.ec2DescribeSecurityGroups({ filter: filter }, function(err, rc) {
               groups = rc;
               next(err);
           });
       },
       function(next) {
           if (req.InstanceId) return next();
           if (!req.ImageId) req.ImageId = (image && image.imageId) || (config && config.ImageId);
           if (!config) return next();
           // Reuse config name but replace the version from the image, this is an image upgrade
           if (!req.LaunchConfigurationName && configName && config) {
               var n = config.LaunchConfigurationName.split(/[ -]/);
               if (configName == n[0]) req.LaunchConfigurationName = configName + "-" + image.name.split("-")[1];
           }
           if (!req.LaunchConfigurationName && image) req.LaunchConfigurationName = image.name;
           if (!req.LaunchConfigurationName) req.LaunchConfigurationName = appName + "-" + appVersion;
           if (!req.InstanceType) req.InstanceType = config.InstanceType || aws.instanceType;
           if (!req.KeyName) req.KeyName = config.KeyName || appName;
           if (!req.IamInstanceProfile) req.IamInstanceProfile = config.IamInstanceProfile || appName;
           if (!req.UserData && config.UserData && typeof config.UserData == "string") req.UserData = config.UserData;
           if (!req['BlockDeviceMappings.member.1.DeviceName']) {
               lib.objGet(config, "BlockDeviceMappings.member", { list: 1 }).forEach(function(x, i) {
                   req["BlockDeviceMappings.member." + (i + 1) + ".DeviceName"] = x.DeviceName;
                   if (x.VirtualName) req["BlockDeviceMappings.member." + (i + 1) + ".VirtualName"] = x.Ebs.VirtualName;
                   if (x.Ebs && x.Ebs.VolumeSize) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.VolumeSize"] = x.Ebs.VolumeSize;
                   if (x.Ebs && x.Ebs.VolumeType) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.VolumeType"] = x.Ebs.VolumeType;
                   if (x.Ebs && x.Ebs.SnapshotId) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.SnapshotId"] = x.Ebs.SnapshotId;
                   if (x.Ebs && x.Ebs.Iops) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.Iops"] = x.Ebs.Iops;
                   if (x.Ebs && x.Ebs.Encrypted) req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.Encrypted"] = x.Ebs.Encrypted;
                   if (x.Ebs && typeof x.Ebs.DeleteOnTermination == "boolean") req["BlockDeviceMappings.member." + (i + 1) + ".Ebs.DeleteOnTermination"] = x.Ebs.DeleteOnTermination;
               });
           }
           if (!req["SecurityGroups.member.1"]) {
               lib.objGet(config, "SecurityGroups.member", { list: 1 }).forEach(function(x, i) {
                   req["SecurityGroups.member." + (i + 1)] = x;
               });
           }
           if (!req["SecurityGroups.member.1"] && groups) {
               groups.forEach(function(x, i) { req["SecurityGroups.member." + (i + 1)] = x.groupId });
           }
           req.AssociatePublicIpAddress = lib.toBool(req.AssociatePublicIpAddress || config.AssociatePublicIpAddress);
           next();
       },
       function(next) {
           if (config) logger.info("CONFIG:", config);
           if (image) logger.info("IMAGE:", image)
           if (instance) logger.info("INSTANCE:", instance);
           logger.log("CreateLaunchConfig:", req);
           if (lib.isArg("-dry-run")) return shell.exit();
           aws.queryAS("CreateLaunchConfiguration", req, next);
       },
       function(next) {
           if (!lib.isArg("-update-groups") || !config) return next();
           aws.queryAS("DescribeAutoScalingGroups", req, function(err, rc) {
               groups = lib.objGet(rc, "DescribeAutoScalingGroupsResponse.DescribeAutoScalingGroupsResult.AutoScalingGroups.member", { list: 1 });
               lib.forEachSeries(groups, function(group, next2) {
                   if (group.LaunchConfigurationName.split("-")[0] != config.LaunchConfigurationName.split("-")[0]) return next2();
                   aws.queryAS("UpdateAutoScalingGroup", { AutoScalingGroupName: group.AutoScalingGroupName, LaunchConfigurationName: req.LaunchConfigurationName }, next2);
               }, next);
           });
       },
    ], function(err) {
        shell.exit(err);
    });
}

// If executed as standalone script directly in the node
if (!module.parent) core.init({ role: "shell" }, function(err, opts) { shell.run(opts); });
