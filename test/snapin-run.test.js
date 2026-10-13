const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the public plugin handler against a local FOG API stub. Config and
// history stay in memory; these tests never read real credentials or task hosts.
async function harness(t, respond) {
    const requests = [];
    const scheduledTasks = new Map();
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const request = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null };
            requests.push(request);
            function defaultReply() {
                if (request.method === 'POST' && request.path === '/fog/scheduledtask/create') {
                    const task = { ...request.body, id: String(700 + scheduledTasks.size) };
                    scheduledTasks.set(task.id, task);
                    return { status: 200, data: task };
                }
                const match = request.path.match(/^\/fog\/scheduledtask\/(\d+)$/);
                if (request.method === 'GET' && match) {
                    return scheduledTasks.has(match[1])
                        ? { status: 200, data: scheduledTasks.get(match[1]) }
                        : { status: 404, data: { error: 'Not found' } };
                }
                return { status: 200, data: '' };
            }
            const reply = (respond && respond(request, defaultReply)) || defaultReply();
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply.data));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));

    const root = path.resolve(__dirname, '..');
    const files = new Map([[path.join(root, 'fog-config.json'), JSON.stringify({
        fogUrl: 'http://127.0.0.1:' + server.address().port,
        apiToken: 'test-api-token', userToken: 'test-user-token'
    })]]);
    const fakeFs = {
        readFileSync(file) {
            if (!files.has(file)) throw new Error('ENOENT');
            return files.get(file);
        },
        writeFileSync(file, data) { files.set(file, data); }
    };
    const sandbox = {
        module: { exports: {} }, __dirname: root, Buffer,
        require(name) { return name === 'fs' ? fakeFs : require(name); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'fogctl.js'), 'utf8'), sandbox);
    const plugin = sandbox.module.exports.fogctl({ parent: {} });
    return {
        requests,
        history() { return JSON.parse(files.get(path.join(root, 'fogctl-history.json'))).entries; },
        call(query) {
            return new Promise((resolve, reject) => {
                const res = {
                    status(code) { this.statusCode = code; return this; },
                    set() { return this; },
                    send(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); }
                };
                try {
                    Promise.resolve(plugin.handleAdminReq({ query }, res, {})).catch(reject);
                } catch (error) { reject(error); }
            });
        }
    };
}

test('Run snapin queues only the selected snapin for each host, without association writes', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const response = await h.call({ action: 'snapinRun', snapinId: '42', hostIds: '1038,1039' });
    assert.equal(response.status, 200);
    assert.equal(response.body.results['1038'].ok, true);
    assert.equal(response.body.results['1039'].ok, true);
    assert.deepEqual(h.requests, ['1038', '1039'].map(id => ({
        method: 'POST', path: '/fog/host/' + id + '/task',
        body: { taskTypeID: 13, deploySnapins: 42 }
    })));
    assert.equal(h.history()[0].snapinId, '42');
    assert.equal(h.history()[0].ok, 2);
});

test('snapin ID 1 remains a numeric ID, never the boolean true meaning all snapins', { timeout: 5000 }, async t => {
    const h = await harness(t);
    await h.call({ action: 'snapinRun', snapinId: '1', hostIds: '1038' });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.deploySnapins, 1);
});

test('immediate Single Snapin preserves WoL and shutdown options', { timeout: 5000 }, async t => {
    const h = await harness(t);
    await h.call({ action: 'snapinRun', snapinId: '42', hostIds: '1038', wol: '1', shutdown: '1' });
    assert.deepEqual(h.requests, [{
        method: 'POST', path: '/fog/host/1038/task',
        body: { taskTypeID: 13, deploySnapins: 42, wol: true, shutdown: true }
    }]);
});

test('scheduled Single Snapin stores the selected ID and WoL in FOG scheduler fields', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const scheduledFor = '2030-01-15 10:30';
    const scheduleTime = String(Date.parse('2030-01-15T09:30:00Z') / 1000);
    const response = await h.call({ action: 'snapinRun', snapinId: '42', hostIds: '1038,1039', scheduledFor, scheduleTime, wol: '1', shutdown: '1' });
    assert.equal(response.body.results['1038'].scheduledTaskId, 700);
    assert.equal(response.body.results['1039'].scheduledTaskId, 701);
    assert.deepEqual(h.requests, [1038, 1039].flatMap((id, index) => [{
        method: 'POST', path: '/fog/scheduledtask/create', body: {
            name: 'fogctl 13 host ' + id + ' 2030-01-15T09:30:00.000Z', hostID: id,
            taskTypeID: 13, type: 'S', isGroupTask: 0,
            other2: 42, other3: 'fogctl', scheduleTime: Number(scheduleTime),
            isActive: 1, other4: 1, shutdown: 1, imageID: 0
        }
    }, { method: 'GET', path: '/fog/scheduledtask/' + (700 + index), body: null }]));
    assert.equal(h.history()[0].scheduledFor, scheduledFor);
    assert.equal(h.history()[0].results['1038'].scheduledTaskId, 700);
});

test('rejects missing IDs and all-snapins or malformed values before any FOG request', { timeout: 5000 }, async t => {
    const h = await harness(t);
    for (const snapinId of [undefined, '', '-1', '0', 'true', true, '1.5', '42junk', ['42'], '9007199254740993']) {
        for (const scheduledFor of [undefined, '2030-01-15 10:30']) {
            const response = await h.call({ action: 'snapinRun', snapinId, hostIds: '1038', scheduledFor });
            assert.equal(response.status, 400, 'invalid snapin ID: ' + snapinId);
        }
    }
    const response = await h.call({ action: 'snapinRun', snapinId: '42', hostIds: '' });
    assert.equal(response.status, 400);
    assert.deepEqual(h.requests, []);
});

test('a FOG failure is reported per host without retrying as All Snapins', { timeout: 5000 }, async t => {
    const h = await harness(t, request => request.path === '/fog/host/1038/task'
        ? { status: 500, data: { error: 'Host busy' } }
        : { status: 200, data: '' });
    const response = await h.call({ action: 'snapinRun', snapinId: '42', hostIds: '1038,1039' });
    assert.equal(response.body.results['1038'].ok, false);
    assert.match(response.body.results['1038'].error, /Host busy/);
    assert.equal(response.body.results['1039'].ok, true);
    assert.deepEqual(h.requests, ['1038', '1039'].map(id => ({
        method: 'POST', path: '/fog/host/' + id + '/task',
        body: { taskTypeID: 13, deploySnapins: 42 }
    })));
    assert.equal(h.history()[0].ok, 1);
    assert.equal(h.history()[0].ko, 1);
});

test('active task list identifies Single Snapin tasks', { timeout: 5000 }, async t => {
    const h = await harness(t, () => ({ status: 200, data: {
        tasks: [{ id: 7, hostID: 1038, typeID: 13, stateID: 1 }]
    } }));
    const response = await h.call({ action: 'activeTasks' });
    assert.equal(response.body.tasks[0].label, 'Single Snapin');
});

test('scheduled deploy and capture are read back, with per-host IDs in history', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const scheduleTime = String(Date.parse('2030-01-15T09:30:00Z') / 1000);
    for (const [action, type] of [['deploy', 1], ['capture', 2]]) {
        const response = await h.call({ action, hostIds: '1038,1039', scheduleTime, wol: '1' });
        for (const id of ['1038', '1039']) {
            assert.equal(response.body.results[id].ok, true);
            assert.ok(response.body.results[id].scheduledTaskId);
        }
        assert.equal(h.history()[0].scheduleTime, Number(scheduleTime));
        const posts = h.requests.filter(r => r.path === '/fog/scheduledtask/create' && r.body.taskTypeID === type);
        assert.equal(posts.length, 2);
        for (const request of posts) {
            assert.equal(request.body.scheduleTime, Number(scheduleTime));
            assert.equal(request.body.other4, 1);
            assert.equal(request.body.shutdown, 0);
            assert.equal(request.body.other2, 0);
        }
    }
    assert.equal(h.requests.some(r => /\/host\/\d+\/task$/.test(r.path)), false);
});

test('invalid or ambiguous schedules fail before any FOG mutation', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const invalid = [
        { scheduledFor: '2030-01-15 10:30' }, // Old UI: timezone is missing.
        { scheduleTime: '' }, { scheduleTime: 'NaN' }, { scheduleTime: '0' },
        { scheduleTime: '1.5' }, { scheduleTime: '-1' },
        { scheduleTime: '9999999999999999' },
        { scheduleTime: String(Math.floor(Date.now() / 1000) - 60) },
        { scheduledFor: 'invalidZ' }
    ];
    for (const action of ['deploy', 'capture', 'snapinRun']) {
        for (const schedule of invalid) {
            const response = await h.call({ action, hostIds: '1038', snapinId: '42', ...schedule });
            assert.equal(response.status, 400, action + ': ' + JSON.stringify(schedule));
        }
    }
    assert.deepEqual(h.requests, []);
});

test('an explicit timezone offset reaches FOG as the same absolute instant', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const response = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '42', scheduledFor: '2030-01-15T10:30:00+01:00' });
    assert.equal(response.body.results['1038'].ok, true);
    assert.equal(h.requests[0].body.scheduleTime, Date.parse('2030-01-15T09:30:00Z') / 1000);
});

test('HTTP 200 without a scheduled task ID is not reported as success', { timeout: 5000 }, async t => {
    const h = await harness(t, () => ({ status: 200, data: '' }));
    const response = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '42', scheduleTime: '1894699800' });
    assert.equal(response.body.results['1038'].ok, false);
    assert.match(response.body.results['1038'].error, /did not return a scheduled task ID/);
    assert.equal(h.history()[0].ko, 1);
    assert.equal(h.history()[0].results['1038'].ok, false);
    assert.equal(h.requests.length, 1);
});

test('a missing task on read-back reports the returned ID and never repeats POST', { timeout: 5000 }, async t => {
    const h = await harness(t, request => request.method === 'GET'
        ? { status: 404, data: { error: 'Not found' } } : undefined);
    const response = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '42', scheduleTime: '1894699800' });
    assert.equal(response.body.results['1038'].ok, false);
    assert.match(response.body.results['1038'].error, /#700.*verification failed/);
    assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
});

test('FOG error bodies remain visible even if the HTTP status is 200', { timeout: 5000 }, async t => {
    const h = await harness(t, () => ({ status: 200, data: { error: { message: 'Permission denied' } } }));
    const response = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '42', scheduleTime: '1894699800' });
    assert.equal(response.body.results['1038'].ok, false);
    assert.match(response.body.results['1038'].error, /Permission denied/);
    assert.equal(h.requests.length, 1);
});

test('stored host, type, time, active state and snapin must match the request', { timeout: 5000 }, async t => {
    for (const change of [{ hostID: 1 }, { taskTypeID: 12 }, { type: 'C' }, { isActive: 0 }, { isGroupTask: 1 }, { scheduleTime: 1 }, { other2: -1 }, { other4: 1 }, { shutdown: 1 }]) {
        const h = await harness(t, (request, fallback) => {
            if (request.method !== 'GET') return;
            const reply = fallback();
            return { ...reply, data: { ...reply.data, ...change } };
        });
        const response = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '42', scheduleTime: '1894699800' });
        assert.equal(response.body.results['1038'].ok, false, JSON.stringify(change));
        if (change.isActive === 0) assert.match(response.body.results['1038'].error, /FOG server clock/);
        assert.equal(h.requests.length, 2);
    }
});

test('the browser sends Unix seconds for the selected local time and logs the verified task ID', { timeout: 5000 }, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../views/fogctl.handlebars'), 'utf8');
    const runAction = source.slice(source.indexOf('  function runAction() {'), source.indexOf('  // Resize columns'));
    const controls = {
        actionSel: { value: 'snapin' }, snapinSel: { value: '42' },
        scheduleOn: { checked: true }, scheduleAt: { value: '2030-01-15T10:30' },
        optWol: {}, optShutdown: {}, optJoinAd: {}, optForceName: {}, progress: {}
    };
    const calls = [], logs = [];
    const sandbox = {
        $: id => controls[id], selectedNodeIds: () => ['node1'],
        state: { fogMap: { node1: { id: '1038' } } }, confirm: () => true,
        alert: message => assert.fail(message), log: message => logs.push(message),
        api: (action, params) => {
            calls.push({ action, params });
            return Promise.resolve({ results: { '1038': { ok: true, scheduledTaskId: 700 } } });
        }
    };
    vm.runInNewContext(runAction + '\nrunAction();', sandbox);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.scheduleTime, String(new Date('2030-01-15T10:30').getTime() / 1000));
    assert.ok(logs.some(message => message.includes('scheduled task #700')));
});
