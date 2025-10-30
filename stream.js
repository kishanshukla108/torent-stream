// stream.js
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import http from 'http'
import fs from 'fs'
import mime from 'mime'

const client = new WebTorrent()
const streams = new Map()
// Track magnets/infoHashes that are currently being added to avoid duplicate fetches
const adding = new Map()

// Log client-level errors
try {
    client.on('error', (err) => console.error('WebTorrent client error:', err && (err.stack || err)))
} catch (e) {
    console.warn('Could not attach client error handler', e && e.message)
}

// Helper: create read stream from torrent file and pipe to response with error handling
function safePipeFileToResponse(file, res, opts = {}) {
    const rs = file.createReadStream(opts)

    const onError = (err) => {
        // Log but don't crash the process
        console.warn('Read stream error:', err && err.message)
        try {
            if (!res.headersSent) res.writeHead(500)
        } catch (e) {}
        try { res.end() } catch (e) {}
        // ensure the read stream is cleaned up
        try { rs.destroy() } catch (e) {}
    }

    rs.on('error', onError)

    // If client disconnects, destroy the read stream to stop work and avoid pipeline errors
    res.on('close', () => {
        try { rs.destroy() } catch (e) {}
    })

    res.on('error', () => {
        try { rs.destroy() } catch (e) {}
    })

    // Pipe last so handlers are attached first
    rs.pipe(res)
}

const server = http.createServer(async (req, res) => {
    // ---- Serve index.html ----
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile('index.html', (err, content) => {
            if (err) {
                res.writeHead(500)
                res.end('Error loading index.html')
                return
            }
            // Inject API_BASE for the browser
            const injected = Buffer.from(content).toString('utf8').replace(
                '</head>',
                `<script>window.API_BASE = 'http://localhost:${process.env.PORT || 3000}'</script>\n</head>`
            )
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(injected)
        })
        return
    }

    // ---- Torrent streaming endpoint ----
    if (req.url === '/start-stream') {
        // --- CORS preflight ---
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            })
            res.end()
            return
        }

        if (req.method === 'POST') {
            res.setHeader('Access-Control-Allow-Origin', '*')
            let body = ''
            req.on('data', chunk => body += chunk)
            req.on('end', () => {
                try {
                    const { magnet, fileIndex } = JSON.parse(body)
                    if (!magnet) {
                        res.writeHead(400)
                        res.end(JSON.stringify({ error: 'Magnet link required' }))
                        return
                    }

                    console.log('Adding torrent, fetching metadata...')
                    // Log incoming request body size for debugging and parsed payload
                    console.log(`Received POST /start-stream body length: ${body.length}`)
                    try {
                        const parsed = JSON.parse(body)
                        console.log('Parsed request JSON:', { magnet: parsed.magnet, fileIndex: parsed.fileIndex })
                    } catch (e) {
                        console.log('Could not parse request body as JSON')
                    }

                    // Ensure we only send one response per request
                    let responded = false

                    // Helper to process a ready torrent (either newly added or already present)
                    function processTorrent(torrent) {
                        // If we get a Promise (some APIs return a Promise), resolve it first
                        if (torrent && typeof torrent.then === 'function') {
                            return torrent.then(resolved => processTorrent(resolved)).catch(err => {
                                console.error('Error resolving torrent promise:', err)
                                if (!responded) {
                                    responded = true
                                    res.writeHead(500, { 'Content-Type': 'application/json' })
                                    res.end(JSON.stringify({ error: 'Failed to resolve torrent promise', stack: String(err && err.stack) }))
                                }
                            })
                        }

                        console.log('Torrent ready — infoHash:', torrent && torrent.infoHash)

                        // Defensive validation: ensure we have a valid torrent with files
                        if (!torrent || !torrent.files || !Array.isArray(torrent.files)) {
                            console.error('processTorrent received invalid torrent object:', {
                                torrentType: torrent === null ? 'null' : typeof torrent,
                                keys: torrent ? Object.keys(torrent) : [],
                                snippet: String(torrent).slice(0, 200)
                            })
                            if (!responded) {
                                responded = true
                                res.writeHead(500, { 'Content-Type': 'application/json' })
                                res.end(JSON.stringify({ error: 'Invalid torrent object received', info: 'See server logs for details' }))
                            }
                            return
                        }

                        console.log('files count:', torrent.files.length)
                        torrent.files.forEach((f, i) =>
                            console.log(i, '-', f.name, `(${f.length} bytes)`)
                        )
                        // Build file list info
                        const filesInfo = torrent.files.map((f, i) => ({
                            index: i,
                            name: f.name,
                            length: f.length,
                            mime: mime.getType(f.name) || 'application/octet-stream'
                        }))

                        // If fileIndex is omitted, return the file list so frontend can show choices
                        if (typeof fileIndex === 'undefined' || fileIndex === null) {
                            if (!responded) {
                                responded = true
                                res.writeHead(200, { 'Content-Type': 'application/json' })
                                res.end(JSON.stringify({ infoHash: torrent.infoHash, name: torrent.name, files: filesInfo }))
                            }
                            return
                        }

                        // Otherwise proceed to create stream for the selected file
                        const idx = parseInt(fileIndex, 10) || 0
                        const file = torrent.files[idx] || torrent.files[0]
                        const total = file.length
                        const mimeType = mime.getType(file.name) || 'application/octet-stream'

                        // Create a per-torrent stream server
                        const streamServer = http.createServer((streamReq, streamRes) => {
                            const range = streamReq.headers.range
                            if (!range) {
                                streamRes.writeHead(200, {
                                    'Content-Length': total,
                                    'Content-Type': mimeType
                                })
                                safePipeFileToResponse(file, streamRes)
                            } else {
                                const parts = range.replace(/bytes=/, '').split('-')
                                const start = parseInt(parts[0], 10) || 0
                                const end = parts[1] ? parseInt(parts[1], 10) : total - 1
                                streamRes.writeHead(206, {
                                    'Content-Range': `bytes ${start}-${end}/${total}`,
                                    'Accept-Ranges': 'bytes',
                                    'Content-Length': (end - start) + 1,
                                    'Content-Type': mimeType
                                })
                                safePipeFileToResponse(file, streamRes, { start, end })
                            }
                        })

                        streamServer.listen(0, '127.0.0.1', () => {
                            const port = streamServer.address().port
                            const url = `http://127.0.0.1:${port}/`
                            console.log('Stream ready at:', url)
                            streams.set(torrent.infoHash, { server: streamServer, url })
                            if (!responded) {
                                responded = true
                                res.writeHead(200, { 'Content-Type': 'application/json' })
                                res.end(JSON.stringify({ url }))
                            }
                        })
                    }

                    // Parse magnet to normalize and extract infoHash for reliable dedupe
                    let parsedTorrent = null
                    // Decode the magnet in case parts were percent-encoded
                    let magnetStr = magnet
                    try { magnetStr = decodeURIComponent(magnet) } catch (e) {}

                    // Only attempt to parse if the input resembles a magnet or an infoHash
                    const looksLikeMagnet = /^magnet:\?/.test(magnetStr)
                    const looksLikeHash = /^[A-Fa-f0-9]{40}$/.test(magnetStr.replace(/^urn:btih:/i, ''))
                    if (looksLikeMagnet || looksLikeHash) {
                        try {
                            parsedTorrent = parseTorrent(magnetStr)
                            console.log('parseTorrent result:', { infoHash: parsedTorrent.infoHash, name: parsedTorrent.name })
                        } catch (e) {
                            console.log('parseTorrent failed (input may not be a standard magnet), proceeding with fallback extraction')
                        }
                    } else {
                        console.log('Input does not appear to be a magnet or raw infoHash; skipping parse-torrent and using regex fallback')
                    }

                    // Fallback: extract btih manually if parse-torrent didn't find it
                    if (!parsedTorrent || !parsedTorrent.infoHash) {
                        const m = (magnetStr || '').match(/btih:([A-Fa-f0-9]{40})/i) || (magnetStr || '').match(/([A-Fa-f0-9]{40})/)
                        if (m) {
                            const found = (m[1] || m[0]).toLowerCase()
                            parsedTorrent = parsedTorrent || {}
                            parsedTorrent.infoHash = found
                            console.log('Extracted infoHash via regex fallback:', found)
                        } else {
                            console.log('Could not extract infoHash from magnet')
                        }
                    }

                    // Normalize key for dedupe: prefer infoHash when available
                    const key = (parsedTorrent && parsedTorrent.infoHash) ? parsedTorrent.infoHash : (magnet || '').trim()

                    // If the torrent is already fully added in the client, reuse it (try infoHash first)
                    const existingKey = parsedTorrent && parsedTorrent.infoHash ? parsedTorrent.infoHash : magnet
                    const existing = client.get(existingKey)
                    console.log('addTarget will be used for client.add; existing client.get result:', { existingKey, exists: !!existing })
                    if (existing) {
                        console.log('Existing torrent snapshot:', { type: typeof existing, hasThen: typeof existing.then === 'function', keys: Object.keys(existing || {}) })
                        console.log('Existing torrent object type check:', { type: typeof existing, hasThen: typeof existing.then === 'function' })

                        // If it's a thenable/Promise-like, do not treat it as an existing torrent — proceed to add a normalized magnet
                        if (existing && typeof existing.then === 'function') {
                            console.log('client.get returned a thenable; ignoring and proceeding to add using normalized addTarget')
                        } else {
                            // Defensive: normal object case — use it
                            try {
                                if (existing.ready) {
                                    processTorrent(existing)
                                } else if (typeof existing.on === 'function') {
                                    existing.on('ready', () => processTorrent(existing))
                                } else {
                                    // No event emitter available; assume metadata available
                                    processTorrent(existing)
                                }
                            } catch (e) {
                                // If anything goes wrong, fallback to processing immediately
                                console.warn('Error handling existing torrent object, will attempt to process directly', e && e.message)
                                processTorrent(existing)
                            }
                            return
                        }
                    }

                    // If an add is already in progress for this key, queue the processor to run when ready
                    if (adding.has(key)) {
                        adding.get(key).push(processTorrent)
                        return
                    }

                    // Mark as adding and start add
                    adding.set(key, [processTorrent])

                    // client.add may return a Torrent synchronously or invoke the callback later.
                    let addReturned
                    let addTimeout
                    // try to extract infoHash from the magnet so we can listen for client-level events as a fallback
                    const infoHashMatch = (magnet || '').match(/btih:([A-Fa-f0-9]{40})/i)
                    const parsedInfoHash = infoHashMatch ? infoHashMatch[1].toLowerCase() : null

                    // Choose a normalized add target: prefer a simple magnet built from infoHash
                    const addTarget = (parsedTorrent && parsedTorrent.infoHash) ? `magnet:?xt=urn:btih:${parsedTorrent.infoHash}` : magnet
                    try {
                        addReturned = client.add(addTarget, (torrent) => {
                            // Clear the add timeout if set
                            try { clearTimeout(addTimeout) } catch (e) {}

                            // If client.add invoked callback with a falsy value, fail gracefully
                            if (!torrent) {
                                console.error('client.add callback returned falsy torrent for key:', key)
                                const queued = adding.get(key) || []
                                adding.delete(key)
                                queued.forEach(cb => {
                                    try { cb(null) } catch (e) { console.warn('queued cb error', e && e.message) }
                                })
                                // If this request hasn't already responded, send an error
                                if (!responded) {
                                    responded = true
                                    res.writeHead(500, { 'Content-Type': 'application/json' })
                                    res.end(JSON.stringify({ error: 'client.add failed to return a torrent', info: 'See server logs' }))
                                }
                                return
                            }

                            // attach a safe error handler to avoid uncaught exceptions
                            try {
                                if (torrent && typeof torrent.on === 'function') {
                                    torrent.on('error', (err) => console.warn('Torrent error:', err && err.message))
                                }
                            } catch (e) {
                                console.warn('Error attaching torrent error handler', e && e.message)
                            }

                            // Run queued processors with resolved torrent (handle Promise-like values)
                            const queued = adding.get(key) || []
                            adding.delete(key)
                            queued.forEach(cb => {
                                try {
                                    if (torrent && typeof torrent.then === 'function') {
                                        torrent.then(resolved => cb(resolved)).catch(err => console.warn('queued cb promise error', err && err.message))
                                    } else {
                                        cb(torrent)
                                    }
                                } catch (e) {
                                    console.warn('processor error', e && e.message)
                                }
                            })
                        })
                    } catch (e) {
                        console.error('client.add threw synchronously:', e && (e.stack || e))
                        const queued = adding.get(key) || []
                        adding.delete(key)
                        queued.forEach(cb => { try { cb(null) } catch (e) {} })
                        if (!responded) {
                            responded = true
                            res.writeHead(500, { 'Content-Type': 'application/json' })
                            res.end(JSON.stringify({ error: 'client.add threw an error', stack: String(e && e.stack) }))
                        }
                        return
                    }

                    try { console.log('client.add synchronous return type:', typeof addReturned, addReturned && addReturned.infoHash) } catch (e) {}

                    // If client.add returned a Torrent synchronously, process it now
                    if (addReturned) {
                        try {
                            if (addReturned.ready) {
                                const queued = adding.get(key) || []
                                adding.delete(key)
                                queued.forEach(cb => { try { cb(addReturned) } catch (e) { console.warn('queued cb error', e && e.message) } })
                            } else if (typeof addReturned.on === 'function') {
                                addReturned.on('ready', () => {
                                    const queued = adding.get(key) || []
                                    adding.delete(key)
                                    queued.forEach(cb => { try { cb(addReturned) } catch (e) { console.warn('queued cb error', e && e.message) } })
                                })
                            }
                        } catch (e) {
                            console.warn('Error processing synchronous addReturned:', e && e.message)
                        }
                    }

                    // If the callback never runs within 20s, fail and log diagnostics. Also add a fallback: listen once for client 'torrent' matching infoHash
                    addTimeout = setTimeout(() => {
                        if (adding.has(key)) {
                            console.error('client.add callback timeout for key:', key)
                            // fallback: if we have an parsedInfoHash, listen for the client-wide 'torrent' event once
                            if (parsedInfoHash) {
                                const onTorrent = (t) => {
                                    try {
                                        if (t && t.infoHash && t.infoHash.toLowerCase() === parsedInfoHash) {
                                            client.removeListener('torrent', onTorrent)
                                            const queued = adding.get(key) || []
                                            adding.delete(key)
                                            queued.forEach(cb => { try { cb(t) } catch (e) { console.warn('queued cb error', e && e.message) } })
                                            if (!responded) {
                                                responded = true
                                                res.writeHead(200, { 'Content-Type': 'application/json' })
                                                res.end(JSON.stringify({ infoHash: t.infoHash }))
                                            }
                                        }
                                    } catch (e) { console.warn('onTorrent error', e && e.message) }
                                }
                                client.on('torrent', onTorrent)
                                // Give the fallback an additional short window then fail
                                setTimeout(() => {
                                    try { client.removeListener('torrent', onTorrent) } catch (e) {}
                                }, 5000)
                            }

                            const queued = adding.get(key) || []
                            adding.delete(key)
                            queued.forEach(cb => { try { cb(null) } catch (e) { console.warn('queued cb error', e && e.message) } })
                            if (!responded) {
                                responded = true
                                res.writeHead(504, { 'Content-Type': 'application/json' })
                                res.end(JSON.stringify({ error: 'Timeout waiting for torrent metadata (client.add callback did not run).' }))
                            }
                        }
                    }, 20000)
                } catch (error) {
                    // Log full error on server console for debugging
                    console.error('Error handling /start-stream:', error)
                    // Return error message and stack to help the client debug (useful for local dev)
                    res.writeHead(500, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: error.message, stack: error.stack }))
                }
            })
            return
        }
    }

    // ---- Fallback ----
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
})

// ---- Port handling with retries ----
const basePort = parseInt(process.env.PORT, 10) || 3000
const maxRetries = 10
let listenAttempt = 0

function tryListen(portToTry) {
    server.removeAllListeners('error')
    server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && listenAttempt < maxRetries) {
            console.warn(`Port ${portToTry} in use, trying ${portToTry + 1}...`)
            listenAttempt++
            setTimeout(() => tryListen(portToTry + 1), 200)
            return
        }
        console.error('Server error:', err)
        process.exit(1)
    })

    server.listen(portToTry, () => {
        console.log(`Web interface running at http://localhost:${portToTry}/`)
    })
}

tryListen(basePort)
