const { EventEmitter } = require('events')
const { URL } = require('url')
const m3u8 = require('m3u8-parser')
const miniget = require('miniget')

class HLSInternal extends EventEmitter {

  constructor (options = {}) {
    super()

    this.playlistURL = options.playlistURL ?? null
    this.quality = options.quality ?? 'best'

    this.totalSegments = 0
    this.totalDuration = 0

    this.retires = 0
    this.maxRetries = 5

    this.lastSegment
    this.timeoutHandle
    this.refreshHandle

    this.playlistRefreshInterval = Number(5)
    this.timeoutDuration = Number(60)

    this.stopped = false
    this.resolve
    this.reject
  }

  start () {
    return new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject

      this.refreshPlaylist()
    })
  }

  async loadPlaylist () {
    try {
      const response = await miniget(this.playlistURL).text()
      const parser = new m3u8.Parser()
      const prefetch = []

      parser.addTagMapper({
        expression: /#EXTINF/,
        map(line) {
          return `#EXT-SEG-TITLE:${line.split(',')[1]}`;
        },
        segment: true
      })
      parser.addParser({
        expression: /^#EXT-SEG-TITLE/,
        customType: 'ad',
        dataParser(line) {
          const segmentTitle = line.split(':')[1]
          return !(segmentTitle === '' || segmentTitle === 'live')
        },
        segment: true
      })
      parser.addParser({
        expression: /^#EXT-X-TWITCH-PREFETCH/,
        customType: 'prefetch',
        dataParser(line) {
          prefetch.push({
            prefetch: true,
            uri: line.slice(23)
          })
          return prefetch
        }
      })

      parser.push(response)
      parser.end()

      if (parser.manifest.playlists) {
        this.emit('m3u8Master', parser.manifest)

        let selectedPlaylist
        const qualityMappings = {
          source: 'chunked',
          audio: 'audio_only'
        }

        if (this.quality === 'best') {
          selectedPlaylist = parser.manifest.playlists.reduce((highestBandwidth, playlist) => highestBandwidth.attributes.BANDWIDTH > playlist.attributes.BANDWIDTH ? highestBandwidth : playlist)
        } else {
          selectedPlaylist = parser.manifest.playlists.find(playlist => playlist.attributes.VIDEO.includes(qualityMappings[this.quality] ?? this.quality))
        }
        if (selectedPlaylist) {
          const selectedQuality = Object.keys(qualityMappings).find(key => qualityMappings[key] === selectedPlaylist.attributes.VIDEO) ?? selectedPlaylist.attributes.VIDEO

          this.emit('quality', selectedQuality)
        }

        this.playlistURL = selectedPlaylist?.uri ?? ''

        return await this.loadPlaylist()
      }

      if (this.stopped) return
      
      return parser.manifest
    } catch (error) {
      if (this.stopped) return
      if (this.lastSegment) {
        if (this.retires < this.maxRetries && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
          this.retires += 1

          if (this.timeoutHandle) clearTimeout(this.timeoutHandle) // make sure we dont timeout while retrying

          await new Promise(r => setTimeout(r, Math.max(1000, 550 * this.retires)))
          this.emit('debug', `Retrying m3u8. attempt '${this.retires}/${this.maxRetries}'`)

          return this.loadPlaylist()
        }
        this.emit('debug', `Error parsing m3u8 ${error.message}`)

        return this.stop()
      }
      return this.reject(error)
    }
  }

  async refreshPlaylist () {
    const playlist = await this.loadPlaylist()

    if (this.stopped || !playlist) return

    this.retires = 0
    this.emit('m3u8', (({ segments, ...o }) => o)(playlist))

    const interval = playlist.targetDuration || HLS.playlistRefreshInterval
    const segments = playlist.segments?.map(segment => new Object({
      uri: new URL(segment.uri, this.playlistURL).href,
      segment
    })) ?? []
    const prefetch = playlist.custom?.prefetch?.map(prefetch => new Object({
      uri: new URL(prefetch.uri, this.playlistURL).href,
      segment: prefetch
    })) ?? []
    const allSegments = segments.concat(prefetch)

    this.refreshHandle = setTimeout(() => { this.refreshPlaylist() }, interval * 1000)

    let newSegments = []
    if (!this.lastSegment) {
      this.emit('start')
      newSegments = allSegments.slice(allSegments.length - Number.MAX_SAFE_INTEGER)
    } else {
      const index = allSegments.map(e => e.uri).indexOf(this.lastSegment)

      if (index < 0) {
        newSegments = allSegments
      } else if (index === allSegments.length - 1) {
        // no new segments
        return
      } else {
        newSegments = allSegments.slice(index + 1)
      }
    }

    this.lastSegment = newSegments[newSegments.length - 1].uri

    for (const newSegment of newSegments) {
      this.totalSegments += 1
      this.totalDuration += newSegment.segment.duration ?? 0
      this.emit('uri', newSegment.uri)
      this.emit('segment', new Object({
        segment: this.totalSegments,
        ...Object.assign({}, ...(o => [].concat(...Object.keys(o).map(k => typeof o[k] === 'object' ? (o[k]) : ({[k]: o[k]}))))(newSegment.segment)) // flatten object
      }))
    }

    // Timeout after X seconds without new segment
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle)

    this.timeoutHandle = setTimeout(() => this.stop(), this.timeoutDuration * 1000)
  }

  stop () {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle)
    }
    
    this.stopped = true
    this.emit('finish', {
      totalSegments: this.totalSegments,
      totalDuration: this.totalDuration
    })
    this.resolve()
  }

}

/**
 * Class representing an HLS event emitter
 * @extends EventEmitter
 */
class HLS extends EventEmitter {

  /**
   * Create an HLS reader
   * @param {object} options
   * @param {string} options.playlistURL - The URL to the Playlist m3u8
   * @param {string} [options.quality]   - The quality to select if using a MasterPlaylist.
   */
  constructor (options = {}) {
    super()

    /** @private */
    this.HLSInternal = new HLSInternal(options)

    this.HLSInternal.on('start', () => this.emit('start'))
    this.HLSInternal.on('m3u8Master', masterPlaylist => this.emit('m3u8Master', masterPlaylist))
    this.HLSInternal.on('m3u8', playlist => this.emit('m3u8', playlist))
    this.HLSInternal.on('quality', quality => this.emit('quality', quality))
    this.HLSInternal.on('segment', segment => this.emit('segment', segment))
    this.HLSInternal.on('uri', uri => this.emit('uri', uri))
    this.HLSInternal.on('finish', info => this.emit('finish', info))
    this.HLSInternal.on('debug', debug => this.emit('debug', debug))
  }

  /**
   * Start reading m3u8
   * @return {Promise}
   */
  start () {
    return this.HLSInternal.start()
  }

  /** Manually stop reading m3u8 */
  stop () {
    return this.HLSInternal.stop()
  }

}

module.exports = HLS
