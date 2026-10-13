const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../views/fogctl.handlebars'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }

function ui() {
    const elements = {};
    function $(id) { return elements[id] || (elements[id] = { value: '', checked: false, hidden: false }); }
    $('actionSel').value = 'deploy';
    $('imageSel').value = '39';
    $('snapinSel').value = '41';
    const state = {
        nodes: [{ id: 'n1', name: 'PC-01', meshid: 'room1' }, { id: 'n2', name: 'PC-02', meshid: 'room2' }],
        selectedGroup: null, checkedNodes: {}, fogMap: { n1: { id: '1031' }, n2: { id: '1032' } },
        images: [{ id: '39', name: 'Windows 11' }], snapins: [{ id: '41', name: 'INSTALLATION-MESH' }],
        fogTimezone: 'UTC', fogConnected: true, runBusy: false
    };
    const calls = [], confirmations = [], resolved = [], logs = [];
    const sandbox = {
        $, state, log: text => logs.push(text), showLogs() {}, renderNodes() {}, pollActiveTasks() {}, selectTaskTab() {},
        confirm: text => { confirmations.push(text); return true; }, alert: text => assert.fail(text),
        resolveNodes: nodes => { resolved.push(...nodes.map(n => n.id)); nodes.forEach(n => { state.fogMap[n.id] = { id: '1032' }; }); return Promise.resolve(); },
        api: (action, params) => { calls.push({ action, params }); return Promise.resolve({ results: Object.fromEntries(params.hostIds.split(',').map(id => [id, { ok: true }])) }); }
    };
    vm.runInNewContext(
        section('  function taskTypeLabel(', '  function renderGroups(') +
        section('  function visibleNodes(', '  function renderNodes(') +
        section('  function selectedNodeIds(', '  // Resolve a specific list') +
        section('  function runAction(', '  // Resize columns'), sandbox);
    return { sandbox, state, $, calls, confirmations, resolved, logs };
}

test('summary includes the selected image, hidden selections and excluded hosts', () => {
    const h = ui();
    h.state.checkedNodes = { n1: true, n2: true };
    h.state.selectedGroup = 'room1';
    h.state.fogMap.n2 = null;
    h.sandbox.updateSummary();
    assert.match(h.$('operationSummary').textContent, /Déployer Windows 11 sur 2 postes/);
    assert.match(h.$('summaryDetails').textContent, /1 absent.*exclu.*1 sélectionné.*hors du filtre/);
    assert.equal(h.$('runBtn').disabled, false);
    assert.equal(h.$('checkAll').checked, true);
    h.state.checkedNodes = {};
    h.sandbox.updateSummary();
    assert.equal(h.$('runBtn').disabled, true);
    assert.equal(h.$('clearSelectionBtn').disabled, true);
});

test('action and schedule changes show the relevant fields and an unchanged FOG clock reading', () => {
    const h = ui();
    h.state.checkedNodes = { n1: true };
    h.$('actionSel').value = 'snapin';
    h.$('scheduleOn').checked = true;
    h.$('scheduleAt').value = '2030-10-13T11:00';
    h.$('optWol').checked = true;
    h.sandbox.updateActionUI();
    assert.equal(h.$('imageWrap').hidden, true);
    assert.equal(h.$('snapinWrap').hidden, false);
    assert.match(h.$('operationSummary').textContent, /INSTALLATION-MESH sur 1 poste.*13\/10\/2030 à 11:00.*FOG \(UTC\)/);
    assert.equal(h.$('advancedCount').textContent, 1);
    assert.match(h.$('summaryDetails').textContent, /réveil WoL/);
    h.$('actionSel').value = 'capture';
    h.sandbox.updateActionUI();
    assert.equal(h.$('imageWrap').hidden, true);
    assert.equal(h.$('snapinWrap').hidden, true);
    assert.match(h.$('operationSummary').textContent, /^Capturer une image/);
});

test('button stays unavailable for an unknown FOG host, missing snapin or unavailable FOG timezone', () => {
    const h = ui();
    h.state.checkedNodes = { n1: true };
    h.state.fogMap.n1 = null;
    h.sandbox.updateSummary();
    assert.equal(h.$('runBtn').disabled, true);
    delete h.state.fogMap.n1;
    h.sandbox.updateSummary();
    assert.equal(h.$('runBtn').disabled, false); // May resolve when clicked.
    h.$('actionSel').value = 'snapin'; h.$('snapinSel').value = '';
    h.sandbox.updateSummary();
    assert.equal(h.$('runBtn').disabled, true);
    h.$('actionSel').value = 'deploy'; h.$('scheduleOn').checked = true;
    h.$('scheduleAt').value = '2030-10-13T11:00'; h.state.fogTimezone = null;
    h.sandbox.updateSummary();
    assert.equal(h.$('runBtn').disabled, true);
});

test('running a selection resolves hidden hosts and sends image/options with the same FOG date', async () => {
    const h = ui();
    h.state.checkedNodes = { n1: true, n2: true }; h.state.selectedGroup = 'room1';
    delete h.state.fogMap.n2;
    h.$('scheduleOn').checked = true; h.$('scheduleAt').value = '2030-10-13T11:00';
    h.$('optWol').checked = true; h.$('optShutdown').checked = true;
    await h.sandbox.runAction();
    assert.deepEqual(h.resolved, ['n2']);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].action, 'deploy');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].params)), {
        hostIds: '1031,1032', imageId: '39', scheduledFor: '2030-10-13 11:00', scheduleMode: 'fog', scheduleTimezone: 'UTC', wol: '1', shutdown: '1'
    });
    assert.match(h.confirmations[0], /Windows 11 sur 2 postes.*13\/10\/2030 à 11:00/);
    assert.equal(h.state.runBusy, false);
});

test('duplicate clicks send one request and busy state ends after a request error', async () => {
    const h = ui(); h.state.checkedNodes = { n1: true };
    let rejectRequest;
    h.sandbox.api = (action, params) => { h.calls.push({ action, params }); return new Promise((resolve, reject) => { rejectRequest = reject; }); };
    const first = h.sandbox.runAction();
    await new Promise(resolve => setImmediate(resolve));
    await h.sandbox.runAction();
    assert.equal(h.calls.length, 1);
    assert.equal(h.$('composerFields').disabled, true);
    rejectRequest(new Error('FOG indisponible'));
    await first;
    assert.equal(h.state.runBusy, false);
    assert.equal(h.$('composerFields').disabled, false);
    assert.match(h.$('progress').textContent, /FOG indisponible/);
});

test('declined confirmation releases the form without creating a task', async () => {
    const h = ui(); h.state.checkedNodes = { n1: true };
    h.sandbox.confirm = () => false;
    await h.sandbox.runAction();
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.runBusy, false);
    assert.equal(h.$('runBtn').disabled, false);
});
