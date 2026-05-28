# fogctl — MeshCentral Plugin for FOG Project

Trigger FOG Project tasks (deploy, capture, snapin) on Windows computers managed by MeshCentral. Pick a room (MeshCentral device group), click an action, and the plugin schedules the FOG task on every matching host.

Built for IT admins running classroom/lab fleets where the same image or snapin needs to be pushed to dozens of machines.

## Features

- **Multi-select** computers across one or more MeshCentral device groups
- **Group-aware selection** — pick a group (e.g. `ROOM-H108`) and act on all its Windows hosts
- **FOG host resolution by MAC** — the plugin looks up each MeshCentral node in FOG via `/fog/host/search` and shows the FOG host id + assigned image
- **Live online indicator** (`● green` / `○ red`)
- **Actions**: Deploy image, Capture image, Run snapin
- **Inline progress and logs**
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
2. The status pill at the top shows whether the FOG API is reachable (`FOG OK` or the error)
3. Pick a group on the left (or stay on *All Windows computers*)
4. Tick the computers you want to act on
5. Click **Resolve FOG hosts** — the plugin queries FOG by MAC and shows the matching host + image (or `no FOG host` if FOG doesn't know that MAC)
6. Pick an action:
   - **Deploy image** — schedules task type 1 (image down) on each FOG host
   - **Capture image** — schedules task type 2 (image up). Only meaningful on master/reference machines
   - **Run snapin** — pick a snapin from the dropdown; the plugin associates the snapin to the host (idempotent) then schedules task type 12
7. Click **Run on selected**. A confirmation prompt lists how many FOG hosts will be tasked and how many were skipped (not found in FOG)
8. Watch the progress counter; click **Logs** for per-host results

## How it works

The plugin runs entirely server-side for the FOG calls. The browser only talks to MeshCentral, which proxies a small set of actions through `/pluginadmin.ashx?pin=fogctl&action=...`:

| Action       | Server does                                                    |
|--------------|----------------------------------------------------------------|
| `ping`       | `GET /fog/system/info` to confirm credentials                  |
| `lookupBulk` | `POST /fog/host/search` per MAC                                |
| `deploy`     | `POST /fog/host/{id}/task` with `taskTypeID: 1` per host       |
| `capture`    | same with `taskTypeID: 2`                                      |
| `snapinList` | `GET /fog/snapin`                                              |
| `snapinRun`  | `POST /fog/snapinassociation/create` then `taskTypeID: 12`     |
| `tasks`      | `GET /fog/task/active`                                         |
| `cancel`     | `DELETE /fog/task/{id}/cancel`                                 |

Authentication uses the standard FOG headers `fog-api-token` (system) and `fog-user-token` (user).

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
