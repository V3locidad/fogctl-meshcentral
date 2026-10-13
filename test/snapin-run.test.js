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
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const request = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null };
            requests.push(request);
            const reply = respond ? respond(request) : { status: 200, data: '' };
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
    await h.call({ action: 'snapinRun', snapinId: '42', hostIds: '1038,1039', scheduledFor, wol: '1', shutdown: '1' });
    assert.deepEqual(h.requests, [1038, 1039].map(id => ({
        method: 'POST', path: '/fog/scheduledtask/create',
        body: {
            name: 'fogctl snapin ' + scheduledFor, hostID: id,
            taskTypeID: 13, type: 'S', isGroupTask: 0,
            other2: 42, scheduleTime: Math.floor(Date.parse('2030-01-15T10:30') / 1000),
            isActive: 1, other4: 1, shutdown: true
        }
    })));
    assert.equal(h.history()[0].scheduledFor, scheduledFor);
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
