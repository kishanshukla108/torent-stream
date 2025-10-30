import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import http from 'http'

const client = new WebTorrent()

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
        const { magnet, fileIndex } = req.body

        if (!magnet) {
            res.status(400).json({ error: 'Magnet link required' })
            return
        }

        // Only attempt to parse if the input resembles a magnet or an infoHash
        let parsedTorrent = null
        const magnetStr = magnet
        const looksLikeMagnet = /^magnet:\?/.test(magnetStr)
        const looksLikeHash = /^[A-Fa-f0-9]{40}$/.test(magnetStr.replace(/^urn:btih:/i, ''))

        if (looksLikeMagnet || looksLikeHash) {
            try {
                parsedTorrent = parseTorrent(magnetStr)
                console.log('parseTorrent result:', { infoHash: parsedTorrent.infoHash, name: parsedTorrent.name })
            } catch (e) {
                console.log('parseTorrent failed, proceeding with fallback extraction')
            }
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

        // Add the torrent and wait for metadata
        return new Promise((resolve, reject) => {
            const addTarget = (parsedTorrent && parsedTorrent.infoHash) 
                ? `magnet:?xt=urn:btih:${parsedTorrent.infoHash}` 
                : magnet

            const torrent = client.add(addTarget, torrent => {
                // If we just want the file list, return it
                if (fileIndex === null || fileIndex === undefined) {
                    const filesInfo = torrent.files.map((f, i) => ({
                        index: i,
                        name: f.name,
                        length: f.length
                    }))
                    res.json({ 
                        infoHash: torrent.infoHash,
                        name: torrent.name,
                        files: filesInfo
                    })
                    resolve()
                    return
                }

                // For Vercel, we'll need to return a different URL format
                // You'll need to set up a separate streaming server or use a different approach
                // For now, we'll return the torrent info
                res.json({ 
                    error: 'Direct streaming not supported in serverless environment',
                    info: {
                        infoHash: torrent.infoHash,
                        name: torrent.name,
                        selectedFile: torrent.files[fileIndex || 0].name
                    }
                })
                resolve()
            })

            // Handle errors
            torrent.on('error', err => {
                console.error('Torrent error:', err)
                res.status(500).json({ error: 'Torrent error: ' + err.message })
                resolve()
            })

            // Set a timeout
            setTimeout(() => {
                if (!res.writableEnded) {
                    res.status(504).json({ error: 'Timeout waiting for torrent metadata' })
                    resolve()
                }
            }, 30000)
        })
    } catch (error) {
        console.error('Error handling request:', error)
        res.status(500).json({ error: error.message })
    }
}