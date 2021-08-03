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

    this.lastSegment
    this.timeoutHandle
    this.refreshHandle

    this.playlistRefreshInterval = Number(5)
    this.timeoutDuration = Number(60)

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
        if (this.quality === 'best') {
          this.playlistURL = parser.manifest.playlists.reduce((highestBandwidth, playlist) => highestBandwidth.attributes.BANDWIDTH > playlist.attributes.BANDWIDTH ? highestBandwidth : playlist)?.uri ?? ''
        } else {
          if (this.quality === 'source') this.quality = 'chunked'
          if (this.quality === 'audio') this.quality = 'audio_only'

          this.playlistURL = parser.manifest.playlists.find(playlist => playlist.attributes.VIDEO.includes(this.quality))?.uri ?? ''
        }

        return await this.loadPlaylist()
      }

      return parser.manifest
    } catch (error) {
      if (this.lastSegment) return this.stop()
      return this.reject(error)
    }
  }

  async refreshPlaylist () {
    const playlist = await this.loadPlaylist()

    if (!playlist) return

    this.emit('m3u8', (({ segments, ...o }) => o)(playlist))

    const interval = playlist.targetDuration || HLS.playlistRefreshInterval
    const segments = playlist.segments?.map(segment => new Object({
      uri: new URL(segment.uri, this.playlistURL).href,
      segment
    }))
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
    this.HLSInternal.on('m3u8', playlist => this.emit('m3u8', playlist))
    this.HLSInternal.on('segment', segment => this.emit('segment', segment))
    this.HLSInternal.on('uri', uri => this.emit('uri', uri))
    this.HLSInternal.on('finish', info => this.emit('finish', info))
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
