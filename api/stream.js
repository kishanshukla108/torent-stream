import mime from 'mime'

// This function intentionally returns a JSON explanation because streaming
// via WebTorrent requires a long-running process and open P2P sockets.
// Vercel Serverless Functions are ephemeral and not suitable for direct
// torrent streaming. Returning structured JSON avoids the frontend trying
// to parse an HTML 404/error page which caused the original Unexpected token error.

export default async function handler(req, res) {
  // Allow CORS so the frontend can call this endpoint safely
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  // Informative JSON response instead of attempting to stream in serverless
  res.status(501).json({
    error: 'Streaming not supported in serverless environment',
    message: 'Vercel serverless functions are ephemeral and cannot host long-running P2P streaming.\n' +
      'To stream torrents you must run the Node server version (a long-running process) on a VPS or local machine.\n' +
      'Options:\n' +
      '1) Run the bundled `stream.js` with Node on a server that stays online (recommended).\n' +
      '2) Use WebTorrent Desktop locally to open the magnet or torrent directly.\n' +
      '3) Deploy to a platform that supports long-running processes (DigitalOcean, AWS EC2, Render, etc.).',
    guidance: {
      example_local_command: 'node stream.js',
      note: 'If you want, I can help convert the project to a small Node server you can deploy to a VPS or Render.'
    }
  })
}
