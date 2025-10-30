// stream.js - Express-based streaming server
import express from 'express'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import fs from 'fs'
import mime from 'mime'

const app = express()
app.use(express.json({ limit: '1mb' }))

const client = new WebTorrent()
const streams = new Map() // infoHash -> torrent
const adding = new Map() // key -> [callbacks]

// Attach client-level error logging
client.on('error', (err) => console.error('WebTorrent client error:', err && (err.stack || err)))

function safePipeFileToResponse(file, res, opts = {}) {
  const rs = file.createReadStream(opts)
  rs.on('error', (err) => {
    console.warn('Read stream error:', err && err.message)
    try { if (!res.headersSent) res.status(500) } catch (e) {}
    try { res.end() } catch (e) {}
    try { rs.destroy() } catch (e) {}
  })
  res.on('close', () => { try { rs.destroy() } catch (e) {} })
  res.on('error', () => { try { rs.destroy() } catch (e) {} })
  rs.pipe(res)
}

// Serve index.html with injected API_BASE
app.get('/', (req, res) => {
  fs.readFile('index.html', (err, content) => {
    if (err) return res.status(500).send('Error loading index.html')
    const injected = Buffer.from(content).toString('utf8').replace(
      '</head>',
      `<script>window.API_BASE = 'http://localhost:${process.env.PORT || 3000}'</script>\n</head>`
    )
    res.setHeader('Content-Type', 'text/html')
    res.send(injected)
  })
})

// Health
app.get('/health', (req, res) => res.json({ ok: true }))

// Start stream / list files
app.post('/start-stream', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const { magnet, fileIndex } = req.body || {}
  if (!magnet) return res.status(400).json({ error: 'Magnet link required' })

  // Try to parse magnet -> infoHash
  let parsed = null
  try { parsed = parseTorrent(magnet) } catch (e) { /* ignore */ }
  if (!parsed || !parsed.infoHash) {
    const m = (magnet || '').match(/btih:([A-Fa-f0-9]{40})/i) || (magnet || '').match(/([A-Fa-f0-9]{40})/)
    if (m) parsed = { infoHash: (m[1] || m[0]).toLowerCase() }
  }

  const key = parsed && parsed.infoHash ? parsed.infoHash : magnet

  // If already have torrent, use it
  const existing = client.get(key)
  if (existing && !(existing && typeof existing.then === 'function')) {
    if (existing.ready) {
      // prepare response
      const files = existing.files.map((f, i) => ({ index: i, name: f.name, length: f.length }))
      if (fileIndex === null || fileIndex === undefined) return res.json({ infoHash: existing.infoHash, name: existing.name, files })
      // return stream URL
      return res.json({ url: `/stream/${existing.infoHash}/${fileIndex}` })
    }
    // wait for ready
    await new Promise((resolve, reject) => {
      existing.once('ready', resolve)
      existing.once('error', reject)
      // timeout
      setTimeout(() => resolve(), 20000)
    })
    const files = existing.files.map((f, i) => ({ index: i, name: f.name, length: f.length }))
    if (fileIndex === null || fileIndex === undefined) return res.json({ infoHash: existing.infoHash, name: existing.name, files })
    return res.json({ url: `/stream/${existing.infoHash}/${fileIndex}` })
  }

  // Deduplicate concurrent adds
  if (adding.has(key)) {
    // queue a promise
    await new Promise((resolve) => adding.get(key).push(() => resolve()))
    const t = client.get(key)
    if (t && t.ready) {
      const files = t.files.map((f, i) => ({ index: i, name: f.name, length: f.length }))
      if (fileIndex === null || fileIndex === undefined) return res.json({ infoHash: t.infoHash, name: t.name, files })
      return res.json({ url: `/stream/${t.infoHash}/${fileIndex}` })
    }
  }

  adding.set(key, [])

  try {
    const addTarget = parsed && parsed.infoHash ? `magnet:?xt=urn:btih:${parsed.infoHash}` : magnet
    const torrent = client.add(addTarget)

    torrent.on('error', (err) => console.warn('Torrent error:', err && err.message))

    await new Promise((resolve, reject) => {
      torrent.once('ready', resolve)
      torrent.once('error', reject)
      setTimeout(() => resolve(), 20000)
    })

    // store for streaming
    streams.set(torrent.infoHash, torrent)

    // run queued callbacks
    const queued = adding.get(key) || []
    adding.delete(key)
    queued.forEach(cb => { try { cb() } catch (e) {} })

    const files = torrent.files.map((f, i) => ({ index: i, name: f.name, length: f.length }))
    if (fileIndex === null || fileIndex === undefined) return res.json({ infoHash: torrent.infoHash, name: torrent.name, files })
    return res.json({ url: `/stream/${torrent.infoHash}/${fileIndex}` })
  } catch (err) {
    adding.delete(key)
    console.error('Error adding torrent:', err && (err.stack || err))
    return res.status(500).json({ error: err && err.message ? err.message : String(err) })
  }
})

// Stream route with range support
app.get('/stream/:infoHash/:fileIndex', (req, res) => {
  const { infoHash, fileIndex } = req.params
  const torrent = streams.get(infoHash) || client.get(infoHash)
  if (!torrent) return res.status(404).json({ error: 'Torrent not found. Ensure it was added via /start-stream first.' })
  const idx = parseInt(fileIndex, 10) || 0
  const file = torrent.files[idx]
  if (!file) return res.status(404).json({ error: 'File not found' })

  const total = file.length
  const mimeType = mime.getType(file.name) || 'application/octet-stream'
  const range = req.headers.range
  if (!range) {
    res.setHeader('Content-Length', total)
    res.setHeader('Content-Type', mimeType)
    return safePipeFileToResponse(file, res)
  }
  const parts = range.replace(/bytes=/, '').split('-')
  const start = parseInt(parts[0], 10) || 0
  const end = parts[1] ? parseInt(parts[1], 10) : total - 1
  const chunkSize = (end - start) + 1
  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', chunkSize)
  res.setHeader('Content-Type', mimeType)
  return safePipeFileToResponse(file, res, { start, end })
})

// Start server
const port = parseInt(process.env.PORT, 10) || 3000
const server = app.listen(port, () => console.log(`Server listening on http://0.0.0.0:${port}`))

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...')
  server.close(() => {
    try { client.destroy(() => process.exit(0)) } catch (e) { process.exit(0) }
  })
})

