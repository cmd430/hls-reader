const HLS = require('./index')

async function test () {
  const hls = new HLS({
    playlistURL: '<url to m3u8>.m3u8'
  })

  hls.once('start', () => {
    console.log('Started reading HLS manifest')
  })
  hls.on('m3u8', m3u8 => {
    console.log('Parsed m3u8 Meta', m3u8)
  })
  hls.on('segment', segment => {
    console.log('New segment', segment)
  })
  hls.on('uri', uri => {
    console.log('New segment URI', uri)
  })
  hls.once('finish', () => {
    console.log('Finished reading HLS manifest')
  })

  try {
    await hls.start()
  } catch (err) {
    console.error(err)
  }

}

test()
