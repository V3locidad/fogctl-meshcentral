/**
 * MeshCentral plugin: fogctl
 *
 * Bridges MeshCentral devices to a FOG Project server. Lets an admin select
 * one or several Windows computers (or a whole MeshCentral group) and trigger
 * a FOG task: deploy image, capture image, or run a snapin.
 *
 * FOG hosts are resolved from MeshCentral nodes by MAC address via the FOG
 * REST API (/fog/host/search). FOG credentials and URL are read from
 * fog-config.json in the plugin directory (NOT exposed over HTTP).
 */
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var url = require('url');

module.exports.fogctl = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = ['onDeviceRefreshEnd'];

    var configFile = path.join(__dirname, 'fog-config.json');

    function loadConfig() {
        try {
            var raw = fs.readFileSync(configFile, 'utf8');
            var c = JSON.parse(raw);
            if (!c.fogUrl) throw new Error('fogUrl missing');
            if (!c.apiToken) throw new Error('apiToken missing');
            if (!c.userToken) throw new Error('userToken missing');
            return c;
        } catch (e) {
            return null;
        }
    }

    // Low-level FOG API call. Returns a promise resolving to parsed JSON.
    function fogCall(method, apiPath, bodyObj) {
        return new Promise(function (resolve, reject) {
            var cfg = loadConfig();
            if (!cfg) return reject(new Error('fog-config.json missing or invalid'));

            var u = url.parse(cfg.fogUrl);
            var isHttps = (u.protocol === 'https:');
            var lib = isHttps ? https : http;
            var fullPath = (u.pathname && u.pathname !== '/' ? u.pathname : '') + apiPath;
            var bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;

            var opts = {
                host: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: fullPath,
                method: method,
                headers: {
                    'fog-api-token': cfg.apiToken,
                    'fog-user-token': cfg.userToken,
                    'Accept': 'application/json'
                }
            };
            if (bodyStr) {
                opts.headers['Content-Type'] = 'application/json';
                opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
            }
            if (isHttps && cfg.rejectUnauthorized === false) opts.rejectUnauthorized = false;

            var req = lib.request(opts, function (res) {
                var chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () {
                    var text = Buffer.concat(chunks).toString('utf8');
                    var data = null;
                    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: res.statusCode, data: data });
                    } else if (res.statusCode >= 300 && res.statusCode < 400) {
                        // Redirects usually mean wrong URL or unauthenticated (FOG sends you to its login page).
                        reject(new Error('FOG ' + res.statusCode + ' redirect to: ' + (res.headers.location || '(no Location header)')));
                    } else {
                        reject(new Error('FOG ' + res.statusCode + ': ' + (data && data.error ? data.error : text.slice(0, 200))));
                    }
                });
            });
            req.on('error', function (err) { reject(err); });
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    function normalizeMac(m) {
        if (!m) return '';
        return String(m).toLowerCase().replace(/[^0-9a-f]/g, '');
    }

    // Search a FOG host by MAC. FOG accepts the raw MAC string.
    function findHostByMac(mac) {
        var clean = normalizeMac(mac);
        if (clean.length !== 12) return Promise.resolve(null);
        var pretty = clean.match(/.{2}/g).join(':');
        return fogCall('POST', '/fog/host/search', { mac: pretty })
            .then(function (r) {
                var hosts = (r.data && r.data.hosts) || r.data || [];
                if (!hosts.length) return null;
                return hosts[0];
            })
            .catch(function () { return null; });
    }

    obj.server_startup = function () {};

    // Inject the FOG tab into device views. Same defensive iframe-creation
    // pattern as multilogin: only create once so the UI state survives mesh
    // refreshes.
    obj.onDeviceRefreshEnd = function () {
        pluginHandler.registerPluginTab({
            tabTitle: "FOG",
            tabId: "pluginFogctl"
        });
        var container = document.getElementById('pluginFogctl');
        if (container && !container.querySelector('iframe')) {
            QA('pluginFogctl',
                '<iframe src="/pluginadmin.ashx?pin=fogctl&user=1" ' +
                'style="width:100%;height:760px;border:0"></iframe>');
        }
    };

    function sendJson(res, code, payload) {
        res.status(code || 200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
    }

    obj.handleAdminReq = function (req, res, user) {
        var action = req.query && req.query.action;

        // -------- ping: report whether config is loadable --------
        if (action === 'ping') {
            var cfg = loadConfig();
            if (!cfg) return sendJson(res, 200, { ok: false, error: 'fog-config.json missing or invalid' });
            // /fog/host is the canonical "is the API alive" endpoint — exists in every FOG 1.5.x.
            return fogCall('GET', '/fog/host?count=1')
                .then(function (r) { sendJson(res, 200, { ok: true, fogUrl: cfg.fogUrl, info: { hosts: (r.data && r.data.count) || (Array.isArray(r.data && r.data.hosts) ? r.data.hosts.length : 0) } }); })
                .catch(function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
        }

        // -------- lookup: resolve a single MAC to a FOG host --------
        if (action === 'lookup') {
            var mac = req.query.mac;
            return findHostByMac(mac).then(function (host) {
                sendJson(res, 200, { mac: mac, host: host });
            }).catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- bulk lookup: array of MACs --------
        if (action === 'lookupBulk') {
            var macs = (req.query.macs || '').split(',').filter(Boolean);
            var results = {};
            var queue = macs.slice();
            function next() {
                if (!queue.length) return sendJson(res, 200, results);
                var m = queue.shift();
                return findHostByMac(m).then(function (h) {
                    results[m] = h ? { id: h.id, name: h.name, image: h.imagename || (h.image && h.image.name) } : null;
                    next();
                }).catch(function () { results[m] = null; next(); });
            }
            return next();
        }

        // -------- deploy: schedule task type 1 on a list of FOG host ids --------
        // -------- capture: same but task type 2 --------
        if (action === 'deploy' || action === 'capture') {
            var taskType = (action === 'deploy') ? 1 : 2;
            var ids = (req.query.hostIds || '').split(',').filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { error: 'no host ids' });
            var out = {};
            var qq = ids.slice();
            function step() {
                if (!qq.length) return sendJson(res, 200, { ok: true, results: out });
                var id = qq.shift();
                fogCall('POST', '/fog/host/' + encodeURIComponent(id) + '/task', { taskTypeID: taskType })
                    .then(function (r) { out[id] = { ok: true, data: r.data }; step(); })
                    .catch(function (e) { out[id] = { ok: false, error: e.message }; step(); });
            }
            return step();
        }

        // -------- snapinList: list available snapins --------
        if (action === 'snapinList') {
            return fogCall('GET', '/fog/snapin')
                .then(function (r) {
                    var arr = (r.data && r.data.snapins) || r.data || [];
                    var simple = arr.map(function (s) { return { id: s.id, name: s.name, description: s.description }; });
                    sendJson(res, 200, { snapins: simple });
                })
                .catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- snapinRun: trigger snapin task (type 12) on a list of hosts.
        // FOG associates the snapin to the host first if needed.
        if (action === 'snapinRun') {
            var snapinId = req.query.snapinId;
            var ids2 = (req.query.hostIds || '').split(',').filter(Boolean);
            if (!snapinId) return sendJson(res, 400, { error: 'snapinId required' });
            if (!ids2.length) return sendJson(res, 400, { error: 'no host ids' });
            var out2 = {};
            var qq2 = ids2.slice();
            function assocAndRun(hostId) {
                // Try to associate first (idempotent — FOG returns an error if already linked, which we ignore).
                return fogCall('POST', '/fog/snapinassociation/create', { snapinID: snapinId, hostID: hostId })
                    .catch(function () { return null; })
                    .then(function () {
                        return fogCall('POST', '/fog/host/' + encodeURIComponent(hostId) + '/task', { taskTypeID: 12 });
                    });
            }
            function stepS() {
                if (!qq2.length) return sendJson(res, 200, { ok: true, results: out2 });
                var hid = qq2.shift();
                assocAndRun(hid)
                    .then(function (r) { out2[hid] = { ok: true, data: r.data }; stepS(); })
                    .catch(function (e) { out2[hid] = { ok: false, error: e.message }; stepS(); });
            }
            return stepS();
        }

        // -------- tasks: list active tasks (admin visibility) --------
        if (action === 'tasks') {
            return fogCall('GET', '/fog/task/active')
                .then(function (r) { sendJson(res, 200, r.data); })
                .catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- cancel: cancel a task --------
        if (action === 'cancel') {
            var tid = req.query.taskId;
            if (!tid) return sendJson(res, 400, { error: 'taskId required' });
            return fogCall('DELETE', '/fog/task/' + encodeURIComponent(tid) + '/cancel', null)
                .then(function (r) { sendJson(res, 200, r.data); })
                .catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- default: render the plugin UI --------
        res.render(path.join(__dirname, 'views/fogctl'), { user: user });
    };

    return obj;
};
