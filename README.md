# Torrent Stream

This project contains two modes:

- A long-running Node server (`stream.js`) that runs WebTorrent and serves file streaming. This requires an always-on host (VPS, Render, DigitalOcean, etc.).
- A Vercel-compatible serverless endpoint in `api/start-stream.js` that *does not* run WebTorrent (because serverless cannot host long-running P2P clients). It returns a safe JSON explaining the limitation and extracts `infoHash` from a magnet link.

Why Vercel serverless can't stream
- WebTorrent needs long-lived sockets and sustained connectivity. Serverless functions are ephemeral and often restricted from opening the required sockets, causing runtime failures (FUNCTION_INVOCATION_FAILED).

Recommended deployment (to enable real streaming)
1. Deploy the long-running server (`stream.js`) to Render (Web Service), DigitalOcean App Platform, EC2, or a VPS.

Quick local test
```powershell
# Install dependencies
npm install

# Start server locally
node stream.js
# or during development
npm run dev
```

Docker (recommended for Render / DigitalOcean)

Build and run locally:
```bash
docker build -t torent-stream .
docker run -p 3000:3000 torent-stream
```

Deploy to Render
- Create a new "Web Service" on Render
- Connect your GitHub repo and set the build command to `npm ci --omit=dev` and the start command to `npm start` (which runs `node stream.js`)

If you prefer to keep metadata endpoints on Vercel
- The `api/start-stream.js` endpoint will return JSON with an `infoHash` and a note explaining serverless limitations. Use this only for parsing magnet / infoHash online; streaming must be done from a long-running server.

If you want, I can:
- Create a small Render deployment template (service settings) and a `docker-compose.yml` for local dev.
- Help you push and configure Render or another host.
