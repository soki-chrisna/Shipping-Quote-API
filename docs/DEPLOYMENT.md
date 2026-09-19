# Deployment runbook

## Local Docker

Prerequisite: Docker installed and running; `.env` has a generated API key.

```powershell
docker build -t shipping-quote:local .
docker run --rm --name shipping-quote-local --env-file .env -p 127.0.0.1:3000:3000 shipping-quote:local
```

Use `npm run checkout` in a second terminal. Stop the Node server first if port 3000 is already in use.

## Prepare an Ubuntu VPS

The deployment script does not provision the host. It assumes SSH on port 22, Docker, Bash, and `flock`.
Install Docker from its official instructions. Use a dedicated deploy user with Docker permission.
Authorize a dedicated SSH public key. Keep its private key only in GitHub environment secrets.

On the VPS as the deploy user, create `~/shipping-quote.env`, mode 600, containing:

```text
API_KEY=<generate a new random 64-character hex value>
PORT=3000
```

Use a real secret instead of the angle-bracket placeholder. For example `openssl rand -hex 32` generates one.
Install a TLS reverse proxy such as Caddy using its official instructions, connect your domain's DNS to the VPS,
and configure a Caddyfile with your real domain:

```text
quotes.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Allow required SSH and HTTP/HTTPS traffic; do not expose port 3000 publicly.
Verify DNS and certificate issuance. Keep `/healthz` publicly reachable for monitoring, without secrets.

## GitHub setup

1. Push main; wait for `test` and `publish` to succeed. The deploy job is initially skipped.
2. For a public image, change the GHCR **package visibility** to public after its first publish.
   Repository visibility alone does not make the package public. For a private image, authenticate the VPS
   Docker client with a credential that can read that package before deploying.
3. Create GitHub environment `production`. Configure deployment branch restrictions to `main`;
   add required reviewer approval if available for your repository/account and desired.
4. Add environment secrets:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | VPS hostname or IPv4 address, without protocol/port |
| `DEPLOY_USER` | Dedicated Linux username |
| `DEPLOY_SSH_KEY` | Full dedicated private key, including begin/end lines |
| `DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known_hosts entry for this host |

Obtain the host key through the VPS provider console/trusted administrator and verify its fingerprint.
Do not blindly trust an unauthenticated `ssh-keyscan` result. IPv6/custom SSH ports need a workflow adjustment.

5. Add repository Actions variable `DEPLOY_ENABLED` = `true`.
6. Use Actions → Test, publish, deploy → Run workflow on main. Subsequent main pushes also deploy.

The API key stays on the VPS; it is not embedded in the image or passed through workflow logs.
The deploy script pulls an immutable image digest, serializes deployments, stops/retains the old container,
starts a replacement, and waits for Docker health. Failure restores the previous container and fails the job.
Registry pull failure happens before stopping the old container.

## Post-deployment verification

- Check the deploy job and server `docker ps` / `docker inspect shipping-quote` health.
- Check `https://YOUR_DOMAIN/healthz` and run the client with `API_BASE_URL` set to that HTTPS origin.
- In your local `.env`, use the matching server API key when running that remote client. Never commit it.
- Save run URL, commit SHA, image digest, deployment time, and observed API result in your release record.
- A green container check is local only. TLS/proxy/DNS still need the external client check.

## Recovery limitations

If there was no prior container, failed first deployment has nothing to restore.
Host shutdown/forced cancellation can interrupt recovery. Inspect containers manually; a leftover
`shipping-quote-previous` intentionally blocks another deployment until the operator resolves it.

## Manual version rollback

Find a known-good `ghcr.io/owner/repo@sha256:...` reference from a prior publish run or registry.
On the VPS, use the repository's reviewed `scripts/deploy.sh`:

```bash
bash scripts/deploy.sh ghcr.io/owner/repo@sha256:REPLACE_WITH_REAL_64_HEX_DIGEST
```

The placeholder is deliberately invalid. Supply the real digest; restore compatible env configuration first.
The script gives that version the same health-check gate. Inspect external API behavior afterward.
There are no database migrations in this project; adding them requires a separate data rollback strategy.

## Official setup references

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Caddy reverse proxy quickstart](https://caddyserver.com/docs/quick-starts/reverse-proxy)
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
