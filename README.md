# fogctl — MeshCentral Plugin for FOG Project

Trigger FOG Project tasks (deploy, capture, snapin) on Windows computers managed by MeshCentral. Pick a room (MeshCentral device group), click an action, and the plugin schedules the FOG task on every matching host.

Built for IT admins running classroom/lab fleets where the same image or snapin needs to be pushed to dozens of machines.

## Features

- **French interface in three steps** — select computers, choose an action, then review the execution options and live summary
- **Multi-select** computers across one or more MeshCentral device groups
- **Group-aware selection** — pick a group (e.g. `ROOM-H108`) and act on all its Windows hosts
- **FOG host resolution by MAC** — the plugin looks up each MeshCentral node in FOG via `/fog/host/search` and shows the FOG host id + assigned image
- **Live online indicator** with text and color (green online / gray offline)
- **Actions**: Deploy image, Capture image, Run snapin
- **Inline progress and logs**
- **Task tabs** — switch between active tasks and pending FOG schedules, with dates, host/group names, snapins and FOG IDs
- **Server-side FOG API calls** — credentials never leave the MeshCentral server

## Requirements

- MeshCentral 1.1.0 or later, plugins enabled (`settings.plugins.enabled = true`)
- A reachable FOG Project 1.5.x server (the MeshCentral server must be able to HTTP/HTTPS the FOG URL)
- A FOG API token and a FOG user token (FOG web UI → user settings → API tokens)
- MeshAgents reporting their MAC address (default behaviour)

## Installation

1. In MeshCentral, go to **My Server → Plugins**
2. Click **Download Plugin** and paste this URL:
   ```
   https://raw.githubusercontent.com/V3locidad/fogctl-meshcentral/main/config.json
   ```
3. Install the plugin and toggle it **enabled**
4. On the MeshCentral host, create the FOG config file in the plugin directory:
   ```
   meshcentral/meshcentral-data/plugins/fogctl/fog-config.json
   ```
   Contents:
   ```json
   {
     "fogUrl": "http://fog.your-lan",
     "apiToken": "FOG_API_TOKEN",
     "userToken": "FOG_USER_TOKEN",
     "rejectUnauthorized": true
   }
   ```
   Set `rejectUnauthorized` to `false` if your FOG server uses a self-signed HTTPS certificate.
5. Restart MeshCentral (`systemctl restart meshcentral` or your equivalent)
6. Reload the UI — a new **FOG** tab appears on each device page

## Usage

1. Open any device, click the **FOG** tab
2. The status badge shows whether the FOG API is reachable (**FOG connecté**).
3. In **Choisir les postes**, pick a group or **Tous les postes**, then tick the computers. Selections persist when changing group or search filters; the summary reports selected computers outside the current filter. Use **Effacer la sélection** to clear them all.
4. FOG hosts are resolved automatically. **Actualiser les postes FOG** refreshes the matching host and image; an unknown MAC shows **Absent de FOG**.
5. In **Choisir l’action**, select:
   - **Déployer une image** — task type 1 (image down), using the selected image or each host's assigned image.
   - **Capturer une image** — task type 2 (image up), intended for master/reference machines.
   - **Exécuter un snapin** — a **Single Snapin** task (type 13) for the selected snapin, without adding or changing host associations. This also applies to scheduled execution.
6. In **Définir l’exécution**, enable **Planifier pour plus tard** if needed and enter the date and time **as shown in FOG**. **Options avancées** contains WoL, shutdown, domain join and host naming. **Modèles d’action** saves or loads reusable settings.
7. Check the live **Récapitulatif**, click **Exécuter** or **Planifier**, then confirm. The confirmation reports matching FOG hosts and excluded computers. The form is locked while submitting to prevent duplicate clicks.
8. Follow **Tâches actives** or **Tâches planifiées** below. Select rows to enable **Annuler la sélection**. **Journal** shows per-host results; **Historique** lists previous operations.

The **0.0.41** interface adapts to narrower windows, keeps long device lists scrollable, and shows task states using both text and color. After updating the plugin, reload the FOG panel to load the new interface.

## How it works

The plugin runs entirely server-side for the FOG calls. The browser only talks to MeshCentral, which proxies a small set of actions through `/pluginadmin.ashx?pin=fogctl&action=...`:

| Action       | Server does                                                    |
|--------------|----------------------------------------------------------------|
| `ping`       | `GET /fog/system/info` to confirm credentials                  |
| `lookupBulk` | `POST /fog/host/search` per MAC                                |
| `deploy`     | `POST /fog/host/{id}/task` with `taskTypeID: 1` per host       |
| `capture`    | same with `taskTypeID: 2`                                      |
| `snapinList` | `GET /fog/snapin`                                              |
| `snapinRun`  | `POST /fog/host/{id}/task` with `taskTypeID: 13` and `deploySnapins: <selected snapin ID>` |
| `scheduledTasks` | `GET /fog/scheduledtask/active`, returning a display-only task summary |
| `scheduleInfo` | Return the plugin's configured FOG timezone and current clock reading, without credentials |
| `cancelScheduled` | Read the selected schedule, `DELETE /fog/scheduledtask/{id}`, then verify it returns 404 |
| `tasks`      | `GET /fog/task/active`                                         |
| `cancel`     | `DELETE /fog/task/{id}/cancel`                                 |

Authentication uses the standard FOG headers `fog-api-token` (system) and `fog-user-token` (user).

Scheduled snapin runs use `POST /fog/scheduledtask/create` with `taskTypeID: 13`, `isGroupTask: 0`, and `other2: <selected snapin ID>`. FOG 1.5.x's scheduler reads the snapin ID from `other2` and the WoL option from `other4`; the immediate-task fields `deploySnapins` and `wol` are not stored by that endpoint. See the [FOG scheduler source](https://github.com/FOGProject/fogproject/blob/1.5.10/packages/web/lib/service/taskscheduler.class.php#L238-L249).

### Scheduled tasks

Since **0.0.40**, **Schedule uses the FOG clock**: selecting October 13 at 11:00 requests October 13 at 11:00 in FOG, regardless of the browser or MeshCentral timezone. The browser sends the clock reading unchanged with `scheduleMode=fog`; the server converts it to Unix seconds in `fogTimezone`. The picker, confirmation, Logs, History and scheduled-task list all identify FOG time. The old browser-local conversion from 0.0.37–0.0.39 no longer applies to the UI; reload the panel after updating.

`fogTimezone` is an optional IANA timezone in `fog-config.json`, defaulting to `UTC` (FOG's default and the server shown in the reported screenshots). It **must match FOG Configuration → FOG Settings → FOG_TZ_INFO**. For a FOG server configured for Paris, add `"fogTimezone": "Europe/Paris"`. The API does not expose that setting in FOG 1.5.10, so the plugin does not claim to discover it automatically or change FOG's timezone. The selected date determines the summer/winter offset; invalid dates, past times, and nonexistent or ambiguous DST clock readings are rejected before task creation.

After creation, the plugin checks that FOG's returned `runtime` equals the requested date and time. If it differs (for example because `fogTimezone` does not match FOG), the plugin attempts to remove the new schedule and verifies removal. It reports failure with the task ID if removal cannot be confirmed. Existing schedules are unchanged; cancel and recreate an older schedule to change its time.

Existing API integrations may still deliberately send an absolute `scheduleTime` in Unix seconds or `scheduledFor` as an ISO timestamp with an explicit offset. Those requests retain their absolute-time semantics. Do not combine an absolute timestamp with `scheduleMode=fog`.

A scheduled operation counts as successful only when FOG returns a task ID and `GET /fog/scheduledtask/{id}` confirms the active task, host, type, timestamp and options. Logs and History show the confirmed task ID for each host, or the verification error. A failed verification never retries creation automatically, because the original task may already exist.

In the plugin, open **Tâches planifiées** to see all active schedules from FOG, including those created outside this plugin. The tab shows the target host/group, task type, snapin name (or ID), planned date, status and FOG ID. It loads on startup, refreshes every eight seconds while visible, and supports the **Actualiser** button. A successful scheduled submission opens this tab. Read errors keep the last loaded list visible with a warning.

The **Date prévue (heure FOG)** column shows FOG's `runtime` text unchanged, matching the FOG management page and the scheduling picker. Recurring schedules show their cron expression and next run in FOG time.

Select individual scheduled tasks or use the header checkbox, then click **Annuler la sélection**. After confirmation, the plugin deletes only those schedule IDs, verifies their absence, reports per-task failures in Logs, and refreshes the list. Selections persist across refreshes; failed cancellations remain selected while the schedule is still listed. Active and scheduled selections use separate endpoints and state. Cancelling a recurring schedule removes its recurrence. This does not stop a task that has already started; use **Tâches actives** for that task. FOG 1.5.10's generic `/cancel` route does not handle scheduled records reliably, so the plugin uses resource deletion, as the FOG scheduled-tasks page does.

In FOG itself, open **Task Management → Scheduled Tasks**. A previous history entry containing `2 / 0` alone is not proof that FOG stored both schedules. Check for an existing task before repeating an unconfirmed request.

Existing host associations and previously queued tasks are not changed by this fix. FOG may combine a new single-snapin request with snapin tasks already pending on that host; it does not enqueue all associated snapins merely because another task exists.

## Tests

With Node.js 18 or later, run `node --test test/*.test.js`. The tests use a local HTTP stub and in-memory configuration/history; they do not connect to a live FOG server. Run with `TZ=UTC` and `TZ=Europe/Paris` to verify independence from browser/server timezones. Coverage includes 11:00 input becoming 11:00 in FOG for deploy/capture/snapin, DST transitions, midnight/year boundaries, read-back and rollback failures, cancellation, invalid dates and the immediate Single Snapin behavior. Interface tests cover live summaries, action-specific fields, selections across groups, unavailable inputs, duplicate submission prevention and confirmation cancellation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `FOG: fog-config.json missing or invalid` | The file isn't where the plugin expects it | Create `meshcentral-data/plugins/fogctl/fog-config.json` then restart MeshCentral |
| `FOG: 401: ...` | Tokens wrong or expired | Re-issue the tokens in FOG web UI |
| `FOG: ECONNREFUSED` / `ETIMEDOUT` | MeshCentral server can't reach the FOG URL | Check firewall / DNS from the MeshCentral host (`curl http://fog.local/fog/system/info -H 'fog-api-token: …'`) |
| All hosts show `no FOG host` | MAC mismatch between MeshAgent and FOG | Verify each computer has a non-zero MAC in MeshCentral and is registered in FOG with that MAC |
| FOG tab missing | Plugin not enabled, or server not restarted | Toggle the plugin, then restart MeshCentral |

## License

MIT
