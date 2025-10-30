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

    res.status(200).json({
      fallback: true,
      note: 'This is a fallback response. The actual streaming endpoint may not be deployed.\nPlease ensure api/start-stream.js is committed and redeployed.',
      infoHash
    })
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) })
  }
}
