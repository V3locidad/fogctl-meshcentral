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

    // Local host cache: avoids hammering FOG when several lookups run in a row.
    // We refresh whenever the cache is older than CACHE_TTL_MS.
    var hostCache = { at: 0, hosts: [], macMap: {}, nameMap: {} };
    var CACHE_TTL_MS = 30 * 1000;

    function normalizeName(s) {
        if (!s) return '';
        // Strip an AD domain suffix and lowercase; FOG and MeshCentral often
        // differ only by the FQDN tail (e.g. PC-001 vs PC-001.l-graves.local).
        return String(s).toLowerCase().split('.')[0].trim();
    }

    function buildMaps(hosts) {
        var macMap = {}, nameMap = {};
        hosts.forEach(function (h) {
            if (h.primac) macMap[normalizeMac(h.primac)] = h;
            if (Array.isArray(h.macs)) {
                h.macs.forEach(function (m) {
                    var k = normalizeMac(m);
                    if (k) macMap[k] = h;
                });
            }
            var nk = normalizeName(h.name);
            if (nk) nameMap[nk] = h;
        });
        return { macMap: macMap, nameMap: nameMap };
    }

    // The search endpoint in FOG 1.5.x is finicky across builds: in practice the
    // most reliable approach is to pull the full host list once and resolve MACs
    // locally. A few hundred to a few thousand hosts is trivial for both sides.
    function getAllHosts(force) {
        var now = Date.now();
        if (!force && (now - hostCache.at) < CACHE_TTL_MS && hostCache.hosts.length) {
            return Promise.resolve(hostCache);
        }
        return fogCall('GET', '/fog/host').then(function (r) {
            var arr = (r.data && r.data.hosts) || [];
            var maps = buildMaps(arr);
            hostCache = { at: Date.now(), hosts: arr, macMap: maps.macMap, nameMap: maps.nameMap };
            return hostCache;
        });
    }

    // Resolve a MeshCentral node to a FOG host. Tries MAC first, then hostname.
    function findHost(mac, name) {
        var cleanMac = normalizeMac(mac);
        var cleanName = normalizeName(name);
        return getAllHosts(false).then(function (cache) {
            if (cleanMac.length === 12 && cache.macMap[cleanMac]) return cache.macMap[cleanMac];
            if (cleanName && cache.nameMap[cleanName]) return cache.nameMap[cleanName];
            return null;
        }).catch(function () { return null; });
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

        // -------- lookup: resolve a single MAC and/or hostname to a FOG host --------
        if (action === 'lookup') {
            return findHost(req.query.mac, req.query.name).then(function (host) {
                sendJson(res, 200, { mac: req.query.mac, name: req.query.name, host: host });
            }).catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- bulk lookup: receives `items=key|mac|name,key|mac|name,...`
        // The client passes the MeshCentral nodeId as `key` so it can map results back.
        if (action === 'lookupBulk') {
            var raw = req.query.items || '';
            var items = raw.split(',').filter(Boolean).map(function (s) {
                var p = s.split('|');
                return { key: decodeURIComponent(p[0] || ''), mac: decodeURIComponent(p[1] || ''), name: decodeURIComponent(p[2] || '') };
            });
            return getAllHosts(req.query.refresh === '1').then(function (cache) {
                var results = {};
                items.forEach(function (it) {
                    var h = null;
                    var cm = normalizeMac(it.mac);
                    if (cm.length === 12 && cache.macMap[cm]) h = cache.macMap[cm];
                    if (!h) {
                        var nn = normalizeName(it.name);
                        if (nn && cache.nameMap[nn]) h = cache.nameMap[nn];
                    }
                    results[it.key] = h ? { id: h.id, name: h.name, image: h.imagename || (h.image && h.image.name), matchedBy: cm && cache.macMap[cm] ? 'mac' : 'name' } : null;
                });
                sendJson(res, 200, results);
            }).catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- deploy: task type 1 on a list of FOG host ids --------
        // -------- capture: same but task type 2 --------
        // Optional `imageId` overrides the host's assigned image (deploy only).
        // Optional `scheduledFor` (YYYY-MM-DD HH:MM, FOG server local time) turns
        // the immediate task into a single-shot scheduled task via /fog/scheduledtask.
        if (action === 'deploy' || action === 'capture') {
            var taskType = (action === 'deploy') ? 1 : 2;
            var ids = (req.query.hostIds || '').split(',').filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { error: 'no host ids' });
            var overrideImg = (action === 'deploy' && req.query.imageId) ? req.query.imageId : null;
            var scheduledFor = req.query.scheduledFor || null;
            var wantWol = req.query.wol === '1';
            var wantShutdown = req.query.shutdown === '1';
            var out = {};
            var qq = ids.slice();
            function step() {
                if (!qq.length) return sendJson(res, 200, { ok: true, results: out });
                var id = qq.shift();
                var endpoint, body;
                if (scheduledFor) {
                    var ts = Math.floor(Date.parse(scheduledFor.replace(' ', 'T')) / 1000);
                    endpoint = '/fog/scheduledtask/create';
                    body = {
                        name: 'fogctl ' + action + ' ' + scheduledFor,
                        hostID: parseInt(id, 10),
                        taskTypeID: taskType,
                        scheduleType: 'S',
                        scheduleTimeStamp: ts,
                        isActive: 1
                    };
                } else {
                    endpoint = '/fog/host/' + encodeURIComponent(id) + '/task';
                    body = { taskTypeID: taskType };
                }
                if (overrideImg) body.imageID = overrideImg;
                if (wantWol) body.wol = true;
                if (wantShutdown) body.shutdown = true;
                fogCall('POST', endpoint, body)
                    .then(function (r) { out[id] = { ok: true, data: r.data }; step(); })
                    .catch(function (e) { out[id] = { ok: false, error: e.message }; step(); });
            }
            return step();
        }

        // -------- imageList: list FOG images for the deploy override dropdown --------
        if (action === 'imageList') {
            return fogCall('GET', '/fog/image')
                .then(function (r) {
                    var arr = (r.data && r.data.images) || r.data || [];
                    var simple = arr.map(function (im) { return { id: im.id, name: im.name, os: (im.os && im.os.name) || '' }; });
                    sendJson(res, 200, { images: simple });
                })
                .catch(function (e) { sendJson(res, 500, { error: e.message }); });
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
        // Optional `scheduledFor` turns it into a single-shot scheduled task.
        if (action === 'snapinRun') {
            var snapinId = req.query.snapinId;
            var ids2 = (req.query.hostIds || '').split(',').filter(Boolean);
            var snapinSchedFor = req.query.scheduledFor || null;
            var snapinWol = req.query.wol === '1';
            var snapinShutdown = req.query.shutdown === '1';
            if (!snapinId) return sendJson(res, 400, { error: 'snapinId required' });
            if (!ids2.length) return sendJson(res, 400, { error: 'no host ids' });
            var out2 = {};
            var qq2 = ids2.slice();
            function assocAndRun(hostId) {
                return fogCall('POST', '/fog/snapinassociation/create', { snapinID: snapinId, hostID: hostId })
                    .catch(function () { return null; })
                    .then(function () {
                        var b;
                        var ep;
                        if (snapinSchedFor) {
                            var ts = Math.floor(Date.parse(snapinSchedFor.replace(' ', 'T')) / 1000);
                            ep = '/fog/scheduledtask/create';
                            b = {
                                name: 'fogctl snapin ' + snapinSchedFor,
                                hostID: parseInt(hostId, 10),
                                taskTypeID: 12,
                                scheduleType: 'S',
                                scheduleTimeStamp: ts,
                                isActive: 1
                            };
                        } else {
                            ep = '/fog/host/' + encodeURIComponent(hostId) + '/task';
                            b = { taskTypeID: 12 };
                        }
                        if (snapinWol) b.wol = true;
                        if (snapinShutdown) b.shutdown = true;
                        return fogCall('POST', ep, b);
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

        // -------- tasks: raw passthrough for debugging --------
        if (action === 'tasks') {
            return fogCall('GET', '/fog/task/active')
                .then(function (r) { sendJson(res, 200, r.data); })
                .catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- activeTasks: simplified per-host status used by the UI poller --------
        if (action === 'activeTasks') {
            return fogCall('GET', '/fog/task/active')
                .then(function (r) {
                    var arr = (r.data && r.data.tasks) || r.data || [];
                    var byHost = {};
                    // FOG task type names (subset): 1=Deploy, 2=Capture, 8=Multicast, 12=Snapin
                    var typeNames = { '1': 'Deploy', '2': 'Capture', '8': 'Multicast', '12': 'Snapin' };
                    arr.forEach(function (t) {
                        var hid = t.hostID || (t.host && t.host.id);
                        if (!hid) return;
                        var typeId = String(t.typeID || (t.type && t.type.id) || '');
                        byHost[hid] = {
                            taskId: t.id,
                            type: typeId,
                            label: typeNames[typeId] || ('Task ' + typeId),
                            state: t.stateID || (t.state && t.state.id),
                            stateName: t.stateName || (t.state && t.state.name),
                            percent: t.percent != null ? t.percent : null
                        };
                    });
                    sendJson(res, 200, { byHost: byHost, count: arr.length });
                })
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
