export default function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const body = req.body || {}
    const magnet = body.magnet || null

    // Try to extract an infoHash via a simple regex so response is mildly useful
    let infoHash = null
    if (magnet && typeof magnet === 'string') {
      const m = magnet.match(/btih:([A-Fa-f0-9]{40})/i) || magnet.match(/([A-Fa-f0-9]{40})/)
      if (m) infoHash = (m[1] || m[0]).toLowerCase()
    }

    // Return a non-OK status so the frontend treats this as an informational error
    res.status(501).json({
      error: 'streaming_not_supported_in_serverless',
      fallback: true,
      note: 'This is a fallback response. The actual streaming endpoint is not available on Vercel serverless.\nTo enable streaming, deploy the long-running server (stream.js) to a VPS or Render and point the frontend API_BASE to it.',
      infoHash
    })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) })
  }
}
