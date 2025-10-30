import parseTorrent from 'parse-torrent'

// Note: WebTorrent (a long-running P2P client) is not suitable for
// Vercel serverless functions. Attempting to run it in this environment
// often causes runtime failures (FUNCTION_INVOCATION_FAILED) because
// serverless functions are short-lived and restrict network/socket usage.

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end()
        return
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' })
        return
    }

    try {
        const { magnet, fileIndex } = req.body || {}

        if (!magnet) {
            res.status(400).json({ error: 'Magnet link required' })
            return
        }

        // Try to extract infoHash locally using parse-torrent (no network needed)
        let parsed = null
        try {
            parsed = parseTorrent(magnet)
        } catch (e) {
            // ignore - we'll try regex fallback
        }

        if (!parsed || !parsed.infoHash) {
            const m = (magnet || '').match(/btih:([A-Fa-f0-9]{40})/i) || (magnet || '').match(/([A-Fa-f0-9]{40})/)
            if (m) parsed = { infoHash: (m[1] || m[0]).toLowerCase() }
        }

        // If we are running on Vercel or another serverless platform, avoid running WebTorrent.
        // Instead return the derived infoHash and a clear message that metadata fetching
        // (peers/tracker DHT lookup) isn't supported in this environment.
        const runningServerless = !!(process.env.VERCEL || process.env.FUNCTIONS_WORKER_RUNTIME)

        if (runningServerless) {
            return res.status(200).json({
                infoHash: parsed && parsed.infoHash,
                name: parsed && parsed.name,
                files: null,
                note: 'Metadata fetching and streaming are not supported in serverless functions.\n' +
                      'To fetch file lists or stream bytes, run the long-running Node server (stream.js) on a VPS or locally.',
                guidance: {
                    run_local: 'node stream.js',
                    deploy_options: ['Render (Web Service)', 'DigitalOcean App Platform', 'AWS EC2']
                }
            })
        }

        // If not serverless, fall back to a safe error indicating the environment differs
        res.status(501).json({ error: 'Server environment does not support torrent metadata fetching. Please run the long-running server.' })
    } catch (error) {
        console.error('Error handling request:', error)
        res.status(500).json({ error: error && error.message ? error.message : String(error) })
    }
}