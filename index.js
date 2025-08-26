const { runtime } = require('which-runtime')
const { once } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { performance } = require('perf_hooks')

const { command, arg, flag } = require('paparam')
const goodbye = require('graceful-goodbye')
const IdEnc = require('hypercore-id-encoding')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const HypercoreStats = require('hypercore-stats')
const HyperswarmStats = require('hyperswarm-stats')
const byteSize = require('tiny-byte-size')

const cmd = command('hyperdrive-profiler',
  arg('<key>', 'Public key of the hyperdrive to download'),
  flag('--interval|-i [integer]', 'Interval (in seconds) at which to print the performance stats (default 10)'),
  flag('--ip', 'Print the IP address (obfuscated by default)'),
  flag('--detail', 'Include detailed stats'),

  async function ({ args, flags }) {
    const key = IdEnc.decode(args.key)
    const statsIntervalMs = 1000 * (parseInt(flags.interval || 10))
    const printIp = flags.ip
    const detail = flags.detail

    const tStart = performance.now()
    let secTillMetadata = null
    let secTillFullyDownload = null

    const tmpdir = path.join(os.tmpdir(), `hyperdrive-profiler-tmp-${Math.random().toString(16).slice(2)}`)
    console.info(`Profiling hyperdrive download for ${IdEnc.normalize(key)} using runtime: ${runtime}`)
    console.info(`Using temporary directory ${tmpdir}`)
    console.info(`Printing progress every ${(statsIntervalMs / 1000).toFixed(0)} seconds`)

    try {
      await gcDir(tmpdir)
    } catch {}

    await fs.promises.mkdir(tmpdir)

    const store = new Corestore(tmpdir)

    const hypercoreStats = await HypercoreStats.fromCorestore(store, { cacheExpiryMs: 1000 })

    const drive = new Hyperdrive(store, key)
    const swarm = new Hyperswarm()
    swarm.on('connection', conn => {
      store.replicate(conn)
      conn.on('error', (e) => {
        console.log(`Connection error: ${e.stack}`)
      })
    })

    const swarmStats = new HyperswarmStats(swarm)

    const printStats = () => {
      const elapsedSec = (performance.now() - tStart) / 1000

      let timestampsInfo = `General\n  - Runtime: ${elapsedSec.toFixed(2)} seconds`
      timestampsInfo += '\n  - Metadata found in: '
      timestampsInfo += secTillMetadata
        ? `${secTillMetadata.toFixed(2).toString()} seconds`
        : 'unknown (still connecting...)'
      timestampsInfo += `\n  - Metadata db: ${drive.db.core.contiguousLength} / ${drive.db.core.length} (contiguous length / length)`
      timestampsInfo += `\n  - Blobs core: ${drive.blobs.core.contiguousLength} / ${drive.blobs.core.length} (contiguous length / length)`
      if (secTillFullyDownload) timestampsInfo += `\n  - Fully downloaded in ${secTillFullyDownload.toFixed(2)} seconds`

      const udxInfo = getUdxInfo(swarmStats, elapsedSec)
      const swarmInfo = getSwarmInfo(swarmStats, { printIp, detail })
      const hypercoreInfo = getHypercoreInfo(hypercoreStats, { detail })
      console.log(`${timestampsInfo}\n${udxInfo}${swarmInfo}${hypercoreInfo}`)
      console.log(`${'-'.repeat(50)}\n`)
    }
    const statsInterval = setInterval(printStats, statsIntervalMs)

    let cancelling = true
    goodbye(async () => {
      printStats()
      if (cancelling) console.info('Cancelling before the download is complete...')
      clearInterval(statsInterval)

      console.log('Destroying swarm...')
      await swarm.destroy()
      console.log('Closing corestore...')
      await store.close()
      console.info('Cleaning up temporary directory...')
      await gcDir(tmpdir)
      console.log('fully done...')
    })

    await drive.ready()

    swarm.join(drive.discoveryKey, { server: false, client: true })
    if (drive.db.core.length <= 1) await once(drive.db.core, 'append') // DEVNOTE: in theory we could get a not-latest length, but 'good enough'
    secTillMetadata = (performance.now() - tStart) / 1000

    console.info(`Downloading drive version ${drive.version}`)
    console.log(`\n${'-'.repeat(50)}\n`)
    await drive.download('/', { wait: true }).done()

    secTillFullyDownload = (performance.now() - tStart) / 1000
    cancelling = false
    goodbye.exit()
  }
)

async function gcDir (dir) {
  await fs.promises.rm(dir, { recursive: true })
}

function getHypercoreInfo (stats, { detail }) {
  let res = `Hypercore stats
  - Hotswaps: ${stats.totalHotswaps}
`
  if (detail) {
    res += `  - Commands:
    - Sync: ${stats.totalWireSyncReceived} received / ${stats.totalWireSyncTransmitted} transmitted
    - Request: ${stats.totalWireRequestReceived} received / ${stats.totalWireRequestTransmitted} transmitted
    - Cancel: ${stats.totalWireCancelReceived} received / ${stats.totalWireCancelTransmitted} transmitted
    - Data: ${stats.totalWireDataReceived} received / ${stats.totalWireDataTransmitted} transmitted
    - Want: ${stats.totalWireWantReceived} received / ${stats.totalWireWantTransmitted} transmitted
    - Bitfield: ${stats.totalWireBitfieldReceived} received / ${stats.totalWireBitfieldTransmitted} transmitted
    - Range: ${stats.totalWireRangeReceived} received / ${stats.totalWireRangeTransmitted} transmitted
    - Extension: ${stats.totalWireExtensionReceived} received / ${stats.totalWireExtensionTransmitted} transmitted
`
  }

  return res
}

function getSwarmInfo (swarmStats, { printIp, detail }) {
  const address = printIp
    ? swarmStats.dhtStats.getRemoteAddress()
    : 'xxx.xxx.xxx.xxx'
  const firewalled = swarmStats.dhtStats.isFirewalled
  let res = `Connection info
  - Address: ${address} (firewalled: ${firewalled})
  - Connections:
    - Attempted: ${swarmStats.connects.client.attempted}
    - Opened: ${swarmStats.connects.client.opened}
    - Closed: ${swarmStats.connects.client.closed}
  - Connection issues:
    - Retransmission timeouts: ${swarmStats.getRTOCountAcrossAllStreams()}
    - Fast recoveries: ${swarmStats.getFastRecoveriesAcrossAllStreams()}
    - Retransmits: ${swarmStats.getRetransmitsAcrossAllStreams()}
`

  if (detail) {
    const { consistent, random, open } = swarmStats.dhtStats.punches
    res += `  - Punches:
    - Consistent: ${consistent}
    - Random: ${random}
    - Open: ${open}
`

    res += `  - Total Queries: ${swarmStats.dhtStats.queries.total}
  - DHT commands
    - Ping: ${swarmStats.dhtStats.pingCmds.rx} received / ${swarmStats.dhtStats.pingCmds.tx} transmitted
    - Ping NAT: ${swarmStats.dhtStats.pingNatCmds.rx} received / ${swarmStats.dhtStats.pingNatCmds.tx} transmitted
    - Down Hint: ${swarmStats.dhtStats.downHintCmds.rx} received / ${swarmStats.dhtStats.downHintCmds.tx} transmitted
    - Find Node: ${swarmStats.dhtStats.findNodeCmds.rx} received / ${swarmStats.dhtStats.findNodeCmds.tx} transmitted
`
  }

  return res
}

function getUdxInfo (swarmStats, elapsedSec) {
  const bytesRx = swarmStats.dhtStats.udxBytesReceived
  const bytesRxPerSec = (bytesRx / elapsedSec).toFixed(2)
  const bytesTx = swarmStats.dhtStats.udxBytesTransmitted
  const bytesTxPerSec = (bytesTx / elapsedSec).toFixed(2)
  const packetsRx = swarmStats.dhtStats.udxPacketsReceived
  const packetsRxPerSec = (packetsRx / elapsedSec).toFixed(0)
  const packetsTx = swarmStats.dhtStats.udxPacketsTransmitted
  const packetsTxPerSec = (packetsTx / elapsedSec).toFixed(0)

  const packetsDropped = swarmStats.dhtStats.udxPacketsDropped
  const packetsDroppedPerSec = (packetsDropped / elapsedSec).toFixed(2)

  return `Network (UDX)
  - Bytes received: ${byteSize(bytesRx)} (${byteSize(bytesRxPerSec)} / second)
  - Bytes transmitted: ${byteSize(bytesTx)} (${byteSize(bytesTxPerSec)} / second)
  - Packets received: ${packetsRx} (${packetsRxPerSec} / second)
  - Packets transmitted: ${packetsTx} (${packetsTxPerSec} / second)
  - Packets dropped: ${swarmStats.dhtStats.udxPacketsDropped} (${packetsDroppedPerSec} / second)
`
}

cmd.parse()
