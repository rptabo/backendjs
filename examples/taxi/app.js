//
// Backend app
// Created by vlad on Mon Apr 28 18:13:47 EDT 2014
//
var backend = require('backendjs');
var core = backend.core;
var db = backend.db;
var api = backend.api;
var logger = backend.logger;

var center = [ 37.758565, -122.450523 ];

api.describeTables({
    taxi: { id: { primary: 1, pub: 1, notnull: 1 },
            status: { pub: 1 },
            latitude: { type: "real", pub: 1 },
            longitude: { type: "real", pub: 1 },
            mtime: { type: "bigint", now: 1, pub: 1 },
    }
});

api.initApplication = function(callback)
{
    this.app.all('/taxi/center', function(req, res) {
        res.json({ latitude: center[0], longitude: center[1] });
    });

    this.app.all('/taxi/get', function(req, res) {
        var options = api.getOptions(req);
        options.sort = "id";
        options.noscan = 0;
        db.select('taxi', req.query, options, function(err, rows) {
           res.json(rows);
        });
    });

    this.app.all('/taxi/set', function(req, res) {
        if (!req.query.id || !req.query.status) return api.sendRepy(res, { status: 400, message: "id and status is required" });
        var options = api.getOptions(req);
        db.update('taxi', req.query, options, function(err, rows) {
           res.json(rows);
        });
    });

    // Run simulation
    setInterval(updateTaxis, 5000);
    callback()
};

// Simulate taxi location changes
function updateTaxis()
{
    var ids = [ "11", "22", "33" ];
    var statuses = [ "avail", "busy", "scheduled" ];
    var bbox = backend.backend.geoBoundingBox(center[0], center[1], 2); // within 2 km from the center
    var latitude = core.randomNum(bbox[0], bbox[2], 5);
    var longitude = core.randomNum(bbox[1], bbox[3], 5);
    var id = ids[core.randomInt(0, ids.length - 1)];
    var status = statuses[core.randomInt(0, statuses.length - 1)];

    db.put("taxi", { id: id, status: status, latitude: latitude, longitude: longitude });
}

backend.server.start();