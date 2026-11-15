# Deploying Mishmar

Mishmar is one Node process plus a `data/` folder. Phones install it from the browser (Add to Home Screen), so it **must be served over HTTPS**. There's no app store step.

## Option A: a small Linux VM with Docker and Caddy (about $5–15/month)

Works on Azure, DigitalOcean, Linode, Hetzner and similar. Point a DNS name such as `guard.example.org` at the VM first.

```bash
# on the VM (Ubuntu)
sudo apt-get update && sudo apt-get install -y docker.io caddy git
git clone https://github.com/generalwax2018/mishmar.git && cd mishmar
sudo docker build -t mishmar .

# generate the master key ONCE and store a copy in your password manager
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" 2>/dev/null || openssl rand -base64 32)
sudo docker volume create mishmar-data
sudo docker run -d --name mishmar --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v mishmar-data:/data -e MISHMAR_MASTER_KEY="$KEY" -e TRUST_PROXY=1 \
  -e VAPID_SUBJECT=mailto:security@example.org mishmar
sudo docker logs mishmar        # shows the first admin invite code
```

`/etc/caddy/Caddyfile` (Caddy gets and renews the HTTPS certificate automatically):

```
guard.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Then run `sudo systemctl reload caddy`, open `https://guard.example.org`, and redeem the invite code.

Only ports 80 and 443 need to be open to the internet. Keep SSH restricted to your own IP.

**Updating:** `git pull && sudo docker build -t mishmar . && sudo docker rm -f mishmar`, then run the same `docker run` command again. Your data lives in the volume.

## Option B: a container host (Fly.io, Render, Railway)

Deploy from the `Dockerfile`, attach a persistent volume at `/data`, and set these secrets:
- `MISHMAR_MASTER_KEY`
- `TRUST_PROXY=1`
- `VAPID_SUBJECT`

Run **exactly one instance**. Live alerts and rate limits are held in memory. The host provides HTTPS.

## After it's running

1. **Uptime:** point a monitor (UptimeRobot, Better Stack) at `https://your-host/healthz` and have it text you when the site goes down.
2. **Backups:** run `npm run backup` on a schedule. In Docker that's `docker exec mishmar node --no-warnings src/backup.js`. Copy `/data/backups` off the server. Backups never include the master key, so keep that separately.
3. **Two-step sign-in:** have every admin and coordinator turn it on (More › Password & sign-in).
4. **Test on real phones:** on each guard's phone, install the app, turn on alerts, lock the phone, and run a practice drill.
5. **If you changed the code:** set `MISHMAR_SOURCE_URL` to your fork (AGPL section 13).

Every setting is listed in [.env.example](.env.example).
