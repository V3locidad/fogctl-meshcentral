const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the public plugin handler against a local FOG API stub. Config and
// history stay in memory; these tests never read real credentials or task hosts.
async function harness(t, respond, configOverrides = {}) {
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
                    task.runtime = new Date(task.scheduleTime * 1000).toLocaleString('sv-SE', {
                        timeZone: configOverrides.fogTimezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                    });
                    scheduledTasks.set(task.id, task);
                    return { status: 200, data: task };
                }
                const match = request.path.match(/^\/fog\/scheduledtask\/(\d+)$/);
                if (request.method === 'GET' && match) {
                    return scheduledTasks.has(match[1])
                        ? { status: 200, data: scheduledTasks.get(match[1]) }
                        : { status: 404, data: { error: 'Not found' } };
                }
                if (request.method === 'DELETE' && match) {
                    scheduledTasks.delete(match[1]);
                    return { status: 200, data: '' };
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
        apiToken: 'test-api-token', userToken: 'test-user-token', ...configOverrides
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

test('the browser sends the selected FOG clock reading unchanged and logs its timezone', { timeout: 5000 }, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../views/fogctl.handlebars'), 'utf8');
    const runAction = source.slice(source.indexOf('  function runAction() {'), source.indexOf('  // Resize columns'));
    const controls = {
        actionSel: { value: 'snapin' }, snapinSel: { value: '42' },
        scheduleOn: { checked: true }, scheduleAt: { value: '2030-10-13T11:00' },
        optWol: {}, optShutdown: {}, optJoinAd: {}, optForceName: {}, progress: {}
    };
    const calls = [], logs = [], tabs = [];
    const sandbox = {
        $: id => controls[id], selectedNodeIds: () => ['node1'],
        state: { fogMap: { node1: { id: '1038' } }, fogTimezone: 'UTC' }, confirm: () => true,
        alert: message => assert.fail(message), log: message => logs.push(message),
        selectTaskTab: tab => tabs.push(tab),
        api: (action, params) => {
            calls.push({ action, params });
            return Promise.resolve({ results: { '1038': { ok: true, scheduledTaskId: 700 } } });
        }
    };
    vm.runInNewContext(runAction + '\nrunAction();', sandbox);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.scheduledFor, '2030-10-13 11:00');
    assert.equal(calls[0].params.scheduleMode, 'fog');
    assert.equal(calls[0].params.scheduleTimezone, 'UTC');
    assert.equal(calls[0].params.scheduleTime, undefined);
    assert.ok(logs.some(message => message.includes('scheduled task #700')));
    assert.ok(logs.some(message => message.includes('2030-10-13 11:00 — heure FOG (UTC)')));
    assert.deepEqual(tabs, ['scheduled']);
});

test('scheduledTasks lists active schedules from FOG without exposing host credentials', { timeout: 5000 }, async t => {
    const h = await harness(t, request => {
        assert.equal(request.method, 'GET');
        assert.equal(request.path, '/fog/scheduledtask/active');
        return { status: 200, data: { scheduledtasks: [
            { id: '8', hostID: '1031', isActive: '1', type: 'S', taskTypeID: '13', other2: '41', scheduleTime: '1894700000', host: { name: 'PC-LAB', ADPass: 'secret' } },
            { id: '7', hostID: '1038', isActive: '1', type: 'S', taskTypeID: '1', scheduleTime: '1894699800', host: { name: 'PC-00009-LMC' } },
            { id: '9', hostID: '10', isActive: '1', type: 'C', isGroupTask: '1', taskTypeID: '2', group: { name: 'Room A' }, runtime: '2030-01-16 07:00', minute: '0', hour: '7', dayOfMonth: '*', month: '*', dayOfWeek: '1-5', tasktype: { name: 'Capture' } },
            { id: '6', hostID: '1', isActive: '0', type: 'S', taskTypeID: '1' }
        ] } };
    });
    const response = await h.call({ action: 'scheduledTasks' });
    assert.equal(response.status, 200);
    assert.equal(response.body.count, 3);
    assert.deepEqual(response.body.tasks.map(t => t.taskId), ['7', '8', '9']);
    assert.equal(response.body.tasks[1].snapinId, '41');
    assert.equal(response.body.tasks[1].label, 'Single Snapin');
    assert.equal(response.body.tasks[2].isGroup, true);
    assert.equal(response.body.tasks[2].targetName, 'Room A');
    assert.equal(response.body.tasks[2].cron, '0 7 * * 1-5');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
});

test('scheduledTasks distinguishes an empty list from API errors and invalid data', { timeout: 5000 }, async t => {
    for (const [reply, status] of [
        [{ status: 200, data: { scheduledtasks: [] } }, 200],
        [{ status: 200, data: '' }, 500],
        [{ status: 503, data: { error: 'Unavailable' } }, 500]
    ]) {
        const h = await harness(t, () => reply);
        const response = await h.call({ action: 'scheduledTasks' });
        assert.equal(response.status, status);
        if (status === 200) assert.deepEqual(response.body.tasks, []);
        else assert.ok(response.body.error);
    }
});

function scheduledTabHarness() {
    const source = fs.readFileSync(path.join(__dirname, '../views/fogctl.handlebars'), 'utf8');
    const code = source.slice(source.indexOf('  function fogDateInput('), source.indexOf('  function showTasks(v) {'));
    const elements = {};
    const state = {
        taskTab: 'active', scheduledList: [], snapins: [], scheduledLoaded: false,
        scheduledLoading: false, scheduledError: '', checkedTasks: { '99': true },
        checkedScheduledTasks: {}, cancellingScheduled: false,
        fogTimezone: null, fogClockOffset: 0, scheduleInfoError: ''
    };
    const calls = [], params = [], logs = [], alerts = [];
    let reply = { tasks: [] };
    const sandbox = {
        state,
        $: id => elements[id] || (elements[id] = {
            style: {},
            setAttribute(key, value) { this[key] = value; }, focus() { this.focused = true; },
            querySelectorAll() {
                this.boxes = Array.from((this.innerHTML || '').matchAll(/<input[^>]+data-scheduled-id="([^"]+)"[^>]*>/g), match => ({
                    checked: match[0].includes(' checked'), getAttribute() { return match[1]; }
                }));
                return this.boxes;
            }
        }),
        escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        api: (action, data) => { calls.push(action); params.push(data); return Promise.resolve(typeof reply === 'function' ? reply(action, data) : reply); },
        confirm: () => true, log: message => logs.push(message), alert: message => alerts.push(message),
        pollActiveTasks: () => calls.push('activeTasks')
    };
    vm.runInNewContext(code, sandbox);
    return { sandbox, state, elements, calls, params, logs, alerts, reply(value) { reply = value; } };
}

test('scheduled tab renders target, snapin and recurrence safely and preserves rows on failure', async () => {
    const h = scheduledTabHarness();
    h.state.snapins = [{ id: '41', name: '<script>bad</script>' }];
    h.reply({ tasks: [
        { taskId: '8', targetName: '<b>PC</b>', type: '13', label: 'Single Snapin', snapinId: '41', scheduleType: 'S', scheduleTime: 1894699800, runtime: '2030-01-15 09:30' },
        { taskId: '9', targetName: 'Room A', isGroup: true, label: 'Capture', scheduleType: 'C', runtime: '2030-01-16 07:00', cron: '0 7 * * 1-5' }
    ] });
    await h.sandbox.pollScheduledTasks();
    const html = h.elements.scheduledBody.innerHTML;
    assert.ok(html.includes('&lt;b&gt;PC&lt;/b&gt;'));
    assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
    assert.ok(html.includes('Groupe : Room A'));
    assert.ok(html.includes('2030-01-16 07:00'));
    assert.ok(html.includes('2030-01-15 09:30'));
    assert.ok(!html.includes('Europe/Paris'));
    assert.ok(html.includes('0 7 * * 1-5'));
    assert.ok(html.includes('#8'));
    h.reply({ error: 'FOG unavailable' });
    await h.sandbox.pollScheduledTasks();
    assert.equal(h.elements.scheduledBody.innerHTML.replace(/ disabled/g, ''), html);
    assert.match(h.elements.scheduledMessage.textContent, /FOG unavailable.*Dernières données conservées/);
    assert.equal(h.elements.scheduledCount.textContent, 2);
});

test('tabs switch by mouse or keyboard and use separate cancellation controls', async () => {
    const h = scheduledTabHarness();
    h.sandbox.selectTaskTab('scheduled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.elements.activeTasksPane.hidden, true);
    assert.equal(h.elements.scheduledTasksPane.hidden, false);
    assert.equal(h.elements.cancelTasksBtn.hidden, true);
    assert.equal(h.elements.cancelScheduledBtn.hidden, false);
    assert.equal(h.elements.scheduledTasksTab['aria-selected'], 'true');
    assert.match(h.elements.scheduledBody.innerHTML, /Aucune tâche planifiée/);
    let prevented = false;
    h.sandbox.taskTabKeydown({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.elements.activeTasksPane.hidden, false);
    assert.equal(h.elements.cancelTasksBtn.hidden, false);
    assert.equal(h.elements.cancelScheduledBtn.hidden, true);
    assert.equal(h.elements.activeTasksTab.focused, true);
    assert.deepEqual(h.state.checkedTasks, { '99': true });
    assert.deepEqual(h.calls, ['scheduledTasks', 'activeTasks']);
});

test('cancelling schedules deletes only selected IDs once and verifies their absence', { timeout: 5000 }, async t => {
    const h = await harness(t);
    await h.call({ action: 'snapinRun', hostIds: '1031,1032,1033', snapinId: '41', scheduleTime: '1894699800' });
    h.requests.length = 0;
    const response = await h.call({ action: 'cancelScheduled', taskIds: '700,701,700' });
    assert.deepEqual(response.body.results, { '700': { ok: true }, '701': { ok: true } });
    assert.deepEqual(h.requests, ['700', '701'].flatMap(id => ['GET', 'DELETE', 'GET'].map(method => ({
        method, path: '/fog/scheduledtask/' + id, body: null
    }))));
});

test('invalid cancellation IDs never cause a FOG call', { timeout: 5000 }, async t => {
    const h = await harness(t);
    for (const ids of ['', '0', '-1', '1.5', '700,', '700,no', '700/../../task/99', '9007199254740992']) {
        const response = await h.call({ action: 'cancelScheduled', taskIds: ids });
        assert.equal(response.status, 400, ids);
    }
    assert.equal(h.requests.length, 0);
});

test('inactive, missing and malformed schedules are not deleted', { timeout: 5000 }, async t => {
    for (const reply of [
        { status: 200, data: { id: '7', isActive: 0 } },
        { status: 200, data: { id: '8', isActive: 1 } },
        { status: 404, data: { error: 'Missing' } },
        { status: 200, data: '' }
    ]) {
        const h = await harness(t, () => reply);
        const response = await h.call({ action: 'cancelScheduled', taskIds: '7' });
        assert.equal(response.body.results['7'].ok, false);
        assert.deepEqual(h.requests.map(r => r.method), ['GET']);
    }
});

test('cancellation failures stay per-ID and neither a 2xx nor failed verification proves removal', { timeout: 5000 }, async t => {
    const h = await harness(t, (r, fallback) => {
        if (r.method !== 'DELETE') return;
        if (r.path.endsWith('/700')) return { status: 200, data: '' }; // No deletion.
        if (r.path.endsWith('/701')) return { status: 200, data: { error: { message: 'Permission denied' } } };
        return fallback();
    });
    await h.call({ action: 'snapinRun', hostIds: '1031,1032,1033', snapinId: '41', scheduleTime: '1894699800' });
    h.requests.length = 0;
    const response = await h.call({ action: 'cancelScheduled', taskIds: '700,701,702' });
    assert.equal(response.body.results['700'].ok, false);
    assert.match(response.body.results['700'].error, /encore cette planification/);
    assert.match(response.body.results['701'].error, /Permission denied/);
    assert.equal(response.body.results['702'].ok, true);
    assert.equal(h.requests.filter(r => r.method === 'DELETE').length, 3);

    for (const reply of [{ status: 503, data: '' }, { status: 200, data: '' }]) {
        let deleted = false;
        const failing = await harness(t, r => {
            if (r.method === 'DELETE') { deleted = true; return { status: 204, data: '' }; }
            return deleted ? reply : { status: 200, data: { id: 7, isActive: 1 } };
        });
        const result = await failing.call({ action: 'cancelScheduled', taskIds: '7' });
        assert.equal(result.body.results['7'].ok, false);
    }
});

test('scheduled selection survives refresh, supports select-all and prunes disappeared tasks', async () => {
    const h = scheduledTabHarness();
    const tasks = [{ taskId: '7' }, { taskId: '8' }];
    h.reply({ tasks });
    await h.sandbox.pollScheduledTasks();
    const box = h.elements.scheduledBody.boxes[0];
    box.checked = true;
    box.onchange();
    assert.equal(h.elements.scheduledCheckAll.indeterminate, true);
    assert.equal(h.elements.cancelScheduledBtn.disabled, false);
    await h.sandbox.pollScheduledTasks();
    assert.equal(h.elements.scheduledBody.boxes[0].checked, true);
    h.elements.scheduledCheckAll.checked = true;
    h.elements.scheduledCheckAll.onchange();
    assert.deepEqual(Object.keys(h.state.checkedScheduledTasks), ['7', '8']);
    h.reply({ tasks: [tasks[1]] });
    await h.sandbox.pollScheduledTasks();
    assert.deepEqual(Object.keys(h.state.checkedScheduledTasks), ['8']);
    assert.deepEqual(h.state.checkedTasks, { '99': true });
});

test('scheduled cancellation uses its own endpoint, prevents repeats, and retains failed selections', async () => {
    const h = scheduledTabHarness();
    h.state.scheduledList = [{ taskId: '7' }, { taskId: '8' }];
    h.state.checkedScheduledTasks = { '7': true, '8': true };
    let finish;
    h.reply(action => action === 'cancelScheduled' ? new Promise(resolve => { finish = resolve; }) : { tasks: [{ taskId: '8' }] });
    const pending = h.sandbox.cancelSelectedScheduledTasks();
    assert.equal(h.elements.cancelScheduledBtn.disabled, true);
    await h.sandbox.cancelSelectedScheduledTasks();
    await h.sandbox.pollScheduledTasks();
    assert.deepEqual(h.calls, ['cancelScheduled']);
    assert.equal(h.params[0].taskIds, '7,8');
    finish({ results: { '7': { ok: true }, '8': { ok: false, error: 'Denied' } } });
    await pending;
    assert.deepEqual(Object.keys(h.state.checkedScheduledTasks), ['8']);
    assert.deepEqual(h.state.checkedTasks, { '99': true });
    assert.deepEqual(h.calls, ['cancelScheduled', 'scheduledTasks']);
    assert.ok(h.logs.some(log => /1 OK, 1 échec/.test(log)));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.state.cancellingScheduled, false);
});

test('declining confirmation or a failed request never clears scheduled selections', async () => {
    const h = scheduledTabHarness();
    h.state.scheduledList = [{ taskId: '7' }];
    h.state.checkedScheduledTasks = { '7': true };
    h.sandbox.confirm = () => false;
    await h.sandbox.cancelSelectedScheduledTasks();
    assert.deepEqual(h.calls, []);
    h.sandbox.confirm = () => true;
    h.reply(action => action === 'cancelScheduled' ? Promise.reject(new Error('Unavailable')) : { tasks: [{ taskId: '7' }] });
    await h.sandbox.cancelSelectedScheduledTasks();
    assert.deepEqual(Object.keys(h.state.checkedScheduledTasks), ['7']);
    assert.ok(h.alerts[0].includes('Unavailable'));
    assert.equal(h.state.cancellingScheduled, false);
});

test('picker default and label use FOG timezone independently of the browser timezone', async () => {
    const h = scheduledTabHarness();
    h.sandbox.$('scheduleOn').checked = true;
    h.sandbox.$('scheduleAt').value = '';
    h.sandbox.updateScheduleTimezone();
    assert.equal(h.elements.scheduleAt.disabled, true);
    h.reply({ timezone: 'UTC', now: Date.parse('2030-10-13T09:05:00Z') });
    await h.sandbox.loadScheduleInfo();
    assert.equal(h.elements.scheduleTimezone.textContent, 'Heure FOG : UTC');
    assert.equal(h.elements.scheduleAt.disabled, false);
    assert.equal(h.elements.scheduleAt.value, '2030-10-13T10:15');
    h.elements.scheduleAt.value = '2030-10-13T11:00';
    h.sandbox.updateScheduleTimezone();
    assert.equal(h.elements.scheduleAt.value, '2030-10-13T11:00');
    assert.equal(h.sandbox.fogDateInput(Date.parse('2030-07-15T09:00:00Z'), 'Europe/Paris'), '2030-07-15T11:00');
    assert.equal(h.sandbox.fogDateInput(Date.parse('2030-01-15T10:00:00Z'), 'Europe/Paris'), '2030-01-15T11:00');
    h.reply({ error: 'Invalid timezone' });
    await h.sandbox.loadScheduleInfo();
    assert.equal(h.state.fogTimezone, null);
    assert.equal(h.elements.scheduleAt.disabled, true);
});

test('11:00 entered for a UTC FOG server is stored and confirmed as 11:00 on the selected date', { timeout: 5000 }, async t => {
    for (const action of ['deploy', 'capture', 'snapinRun']) {
        const h = await harness(t);
        const r = await h.call({ action, hostIds: '1038', snapinId: '41', scheduleMode: 'fog', scheduleTimezone: 'UTC', scheduledFor: '2030-10-13 11:00' });
        assert.equal(r.body.results['1038'].ok, true, JSON.stringify(r.body));
        const created = h.requests.find(r => r.method === 'POST' && r.path === '/fog/scheduledtask/create');
        assert.equal(created.body.scheduleTime, Date.parse('2030-10-13T11:00:00Z') / 1000);
        assert.ok(created.body.name.endsWith('2030-10-13 11:00 FOG'));
        assert.equal(r.body.results['1038'].data.runtime, '2030-10-13 11:00');
        assert.equal(h.history()[0].scheduleTimezone, 'UTC');
        assert.equal(h.history()[0].scheduledFor, '2030-10-13 11:00');
    }
});

test('configured FOG timezone follows DST and retains date across midnight and year boundaries', { timeout: 5000 }, async t => {
    const h = await harness(t, null, { fogTimezone: 'Europe/Paris' });
    for (const [wall, expected] of [
        ['2030-07-15 11:00', '2030-07-15T09:00:00Z'],
        ['2030-01-15 11:00', '2030-01-15T10:00:00Z'],
        ['2030-01-01 00:15', '2029-12-31T23:15:00Z'],
        ['2030-07-15 00:00', '2030-07-14T22:00:00Z']
    ]) {
        const r = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '41', scheduleMode: 'fog', scheduledFor: wall });
        assert.equal(r.body.results['1038'].ok, true, JSON.stringify(r.body));
        assert.equal(r.body.results['1038'].data.runtime, wall);
        assert.equal(r.body.results['1038'].data.scheduleTime, Date.parse(expected) / 1000);
    }
});

test('invalid, past, DST-ambiguous or conflicting FOG times fail before any FOG calls', { timeout: 5000 }, async t => {
    const h = await harness(t, null, { fogTimezone: 'Europe/Paris' });
    for (const request of [
        { scheduledFor: '2030-03-31 02:30' }, // Skipped in Paris.
        { scheduledFor: '2030-10-27 02:30' }, // Repeated in Paris.
        { scheduledFor: '2030-02-30 11:00' },
        { scheduledFor: '2030-13-13 11:00' },
        { scheduledFor: '2020-10-13 11:00' },
        { scheduledFor: '2030-10-13 24:30' },
        { scheduledFor: '' },
        { scheduledFor: '2030-10-13T11:00Z' },
        { scheduledFor: '2030-10-13 11:00', scheduleTime: '1894699800' },
        { scheduledFor: '2030-10-13 11:00', scheduleTimezone: 'UTC' },
        { scheduledFor: '2030-10-13 11:00', scheduleMode: 'unknown' }
    ]) {
        const r = await h.call({ action: 'deploy', hostIds: '1038', scheduleMode: 'fog', ...request });
        assert.equal(r.status, 400, JSON.stringify(request));
    }
    assert.equal(h.requests.length, 0);
});

test('scheduleInfo exposes only FOG clock metadata and rejects invalid zone configuration', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const r = await h.call({ action: 'scheduleInfo' });
    assert.equal(r.body.timezone, 'UTC');
    assert.equal(r.body.clock, new Date(r.body.now).toISOString().slice(0, 16).replace('T', ' '));
    assert.deepEqual(Object.keys(r.body).sort(), ['clock', 'now', 'timezone']);
    const bad = await harness(t, null, { fogTimezone: 'Not/AZone' });
    assert.equal((await bad.call({ action: 'scheduleInfo' })).status, 400);
    assert.equal((await bad.call({ action: 'snapinRun', hostIds: '1038', snapinId: '41', scheduleMode: 'fog', scheduledFor: '2030-10-13 11:00' })).status, 400);
    assert.equal(bad.requests.length, 0);
});

test('a FOG runtime mismatch removes the new schedule and reports failure instead of a shifted task', { timeout: 5000 }, async t => {
    const h = await harness(t, (req, fallback) => {
        const reply = fallback();
        if (req.method === 'GET' && reply.status === 200) reply.data.runtime = '2030-10-13 13:00';
        return reply;
    });
    const r = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '41', scheduleMode: 'fog', scheduledFor: '2030-10-13 11:00' });
    assert.equal(r.body.results['1038'].ok, false);
    assert.match(r.body.results['1038'].error, /Planification retirée/);
    assert.deepEqual(h.requests.map(r => r.method), ['POST', 'GET', 'DELETE', 'GET']);
    assert.equal(h.history()[0].ko, 1);
});

test('a failed rollback identifies the wrong-time schedule that still needs cancellation', { timeout: 5000 }, async t => {
    const h = await harness(t, (req, fallback) => {
        if (req.method === 'DELETE') return { status: 403, data: { error: 'Denied' } };
        const reply = fallback();
        if (req.method === 'GET' && reply.status === 200) reply.data.runtime = '2030-10-13 13:00';
        return reply;
    });
    const r = await h.call({ action: 'snapinRun', hostIds: '1038', snapinId: '41', scheduleMode: 'fog', scheduledFor: '2030-10-13 11:00' });
    assert.equal(r.body.results['1038'].ok, false);
    assert.match(r.body.results['1038'].error, /retrait non confirmé.*#700/);
    assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
});

test('end-to-end browser 11:00 input reaches the FOG API as 11:00, not 09:00', { timeout: 5000 }, async t => {
    const h = await harness(t);
    const source = fs.readFileSync(path.join(__dirname, '../views/fogctl.handlebars'), 'utf8');
    const runAction = source.slice(source.indexOf('  function runAction() {'), source.indexOf('  // Resize columns'));
    const controls = {
        actionSel: { value: 'snapin' }, snapinSel: { value: '41' },
        scheduleOn: { checked: true }, scheduleAt: { value: '2030-10-13T11:00' },
        optWol: {}, optShutdown: {}, optJoinAd: {}, optForceName: {}, progress: {}
    };
    let finished;
    const result = new Promise(resolve => { finished = resolve; });
    vm.runInNewContext(runAction + '\nrunAction();', {
        $: id => controls[id], selectedNodeIds: () => ['node1'],
        state: { fogMap: { node1: { id: '1038' } }, fogTimezone: 'UTC' },
        confirm: () => true, alert: message => assert.fail(message), log() {}, selectTaskTab() {},
        api: (action, params) => h.call({ action, ...params }).then(r => { finished(r.body); return r.body; })
    });
    const response = await result;
    assert.equal(response.results['1038'].ok, true, JSON.stringify(response));
    assert.equal(response.results['1038'].data.runtime, '2030-10-13 11:00');
    assert.equal(response.results['1038'].data.scheduleTime, Date.parse('2030-10-13T11:00:00Z') / 1000);
});
