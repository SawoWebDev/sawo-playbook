# Making a Docker app reachable from other machines on the LAN (Windows + WSL2)

This server runs Docker Desktop on Windows with WSL2 in **mirrored networking mode**
(`C:\Users\<user>\.wslconfig`: `[wsl2] networkingMode=mirrored`). Mirrored mode is what lets a
container's published port show up on the host's real LAN IP at all — but it also means Windows'
Hyper-V firewall (a separate layer from the classic Windows Firewall / `netsh advfirewall`) blocks
every inbound LAN connection **per port** unless a matching allow rule exists. This is true even
when the classic Windows Firewall is fully disabled (`Get-NetFirewallProfile` shows all profiles
`Enabled: False`) — that setting doesn't touch the Hyper-V layer.

Symptom: `docker compose ps` shows the port correctly bound (`0.0.0.0:3001->3000/tcp`), the app
works from `localhost` on the host, but another machine on the LAN times out connecting to
`http://<host-lan-ip>:3001`. Testing from the host itself against its *own* LAN IP is not a
reliable check here — some setups have a hairpin/loopback quirk on top, so the only ground-truth
test is from a **different** machine.

## How this project is set up

`docker-compose.yml` publishes the web app on `PLAYBOOK_WEB_PORT` (3001 here) bound to `0.0.0.0`,
and `.env` sets `WEB_ORIGIN` / `PUBLIC_APP_URL` to `http://<host-lan-ip>:3001` so CORS and generated
links (invites, QR codes) point at the right address. The web container proxies `/api/*` to the API
container internally, so the browser only ever talks to one origin — no separate rule is needed for
the API's port (4000) unless something needs to reach it directly.

The one LAN-specific allow rule, scoped to the local subnet:

```powershell
# Run in an elevated (Administrator) PowerShell
New-NetFirewallHyperVRule -Name "SAWO-Playbook-Web-LAN" `
  -DisplayName "SAWO Playbook Web (LAN only)" `
  -Direction Inbound -Protocol TCP -LocalPorts 3001 `
  -RemoteAddress "172.16.0.0/255.255.252.0" `
  -Action Allow
```

`-RemoteAddress` should match this network's actual subnet (check with
`Get-NetIPAddress -AddressFamily IPv4`). A pre-existing rule named `WSL-SSH-LAN` on this host follows
the same pattern for SSH (port 2022) — reuse that subnet value for consistency.

## Checklist for a new project on a host like this

1. Confirm the host is actually in mirrored mode: `cat $env:USERPROFILE\.wslconfig`. If it says
   `networkingMode=mirrored` (or the file doesn't exist and you're not sure), assume this applies.
2. Bind the container port to `0.0.0.0` (Docker's default when you write `"3001:3000"` in
   `docker-compose.yml` — no extra config needed there).
3. Set whatever origin/URL env vars the app needs to the host's LAN IP, not `localhost`
   (e.g. this project's `WEB_ORIGIN`, `PUBLIC_APP_URL`).
4. Add one `New-NetFirewallHyperVRule` per port that needs LAN exposure, scoped to the LAN subnet
   (never `Any`, to avoid opening the port to the public internet if this host is ever
   multi-homed). Give each rule a unique `-Name` per project/port so they're easy to find and
   remove later (`Get-NetFirewallHyperVRule | Where DisplayName -match "<project>"`).
5. Verify from a **different device** on the LAN — `Test-NetConnection -ComputerName <host-ip>
   -Port <port>` or opening the URL in a browser. Don't rely on a test run from the host itself.

### If Docker Desktop's engine becomes unresponsive

A heavy build (installing system packages, `npm install`, etc.) can occasionally hang Docker
Desktop's engine on Windows — `docker version`/`docker info` will hang indefinitely while
containers that were already running keep working fine. Recovery:

```powershell
Get-Process "Docker Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process "com.docker.backend" -ErrorAction SilentlyContinue | Stop-Process -Force
wsl --shutdown
Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
# wait ~10-30s, then: docker compose up -d
```

This restarts the engine without losing any volume data; containers just need `docker compose up -d`
again afterward.
