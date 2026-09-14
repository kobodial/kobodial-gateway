# Deploying kobodial-gateway

Africa's Talking calls your gateway over the public internet, so the
service needs a public HTTPS URL before the simulator can reach it.
Anything that runs a container and terminates TLS will do.

## What you need first

- A deployed KoboDial contract (`CONTRACT_ID`).
- The relayer's Soroban secret key — **the same account the contract was
  deployed with as `--admin`**, funded on the network you're using.
- An Africa's Talking sandbox API key.

Read [SECURITY.md](SECURITY.md) before pointing this at mainnet. In
particular: the USSD callback is unauthenticated, the dashboard API is
unauthenticated, and one relayer key must not be shared by more than
one running instance.

## Run it with Docker

```sh
docker build -t kobodial-gateway .

docker run -d --name kobodial-gateway \
  -p 3000:3000 \
  -v kobodial-data:/data \
  -e CONTRACT_ID=C... \
  -e RELAYER_SECRET_KEY=S... \
  -e AFRICAS_TALKING_API_KEY=your-sandbox-key \
  kobodial-gateway
```

Or with compose, reading from a local `.env`:

```sh
docker compose up -d --build
```

Migrations run automatically at startup, so a fresh volume needs no
extra step. The SQLite file lives at `/data` inside the container —
keep that volume, or every registered wallet's local record and the
whole transaction log disappear on the next deploy. (The wallets and
balances themselves are on-chain and survive regardless; what's lost is
this service's own view of them.)

Check it's alive:

```sh
curl https://your-host.example/health
# {"status":"ok"}
```

## Getting a public HTTPS URL

**A container host** — Fly.io, Railway, Render, a VPS behind Caddy or
nginx. Point it at the Dockerfile, set the environment variables above
as secrets (never as plain config — `RELAYER_SECRET_KEY` is a
production secret), attach a persistent volume at `/data`, and expose
port 3000.

**A tunnel, for development only** — with the service running locally:

```sh
ngrok http 3000
# or
cloudflared tunnel --url http://localhost:3000
```

Take the `https://…` URL it prints. A tunnel exposes a service holding
a relayer key to the public internet, so treat it as a temporary
development convenience, not a deployment.

## Point Africa's Talking at it

1. In the [sandbox dashboard](https://account.africastalking.com), under
   USSD, create a channel.
2. Set its callback URL to your public URL plus `/ussd` —
   `https://your-host.example/ussd`.
3. Open [simulator.africastalking.com](https://simulator.africastalking.com),
   enter a phone number in E.164 form, and dial the service code the
   sandbox assigned you.

You should get the KoboDial welcome menu. Full walkthrough — register,
check balance, send — is in the [README](README.md).

## If the simulator shows nothing

Work outward from the service:

1. `curl https://your-host.example/health` — if this fails, the problem
   is the deployment, not Africa's Talking.
2. Check the gateway's logs while dialling. Each request logs
   `ussd request handled` with its sessionId. **No log line means the
   request never arrived** — the callback URL is wrong, isn't HTTPS, or
   doesn't end in `/ussd`.
3. A request that arrives but errors logs the reason. The logs contain
   no PINs or phone numbers by design, so they're safe to share.

## Upgrading

```sh
docker compose pull && docker compose up -d   # or rebuild
```

Migrations are idempotent and run on boot. If you ever run more than
one instance, run `npm run db:migrate` once as a deploy step instead,
and see the sequence-number warning in SECURITY.md — more than one
instance sharing a relayer key is not supported.
