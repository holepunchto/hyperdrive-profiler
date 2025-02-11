#!/usr/bin/env node

const { once } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
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
  flag('--interval|-i [statsIntervalSec]', 'Interval (in seconds) at which to print the performance stats (default 10)'),
  async function ({ args, flags }) {
    const key = IdEnc.decode(args.key)
    const statsIntervalMs = 1000 * (parseInt(flags.statsIntervalSec || 2))

    const tmpdir = path.join(os.tmpdir(), `hyperdrive-profiler-tmp-${Math.random().toString(16).slice(2)}`)
    console.info(`Profiling hyperdrive download for ${IdEnc.normalize(key)}`)
    console.info(`Using temporary directory ${tmpdir}`)

    try {
      await gcDir(tmpdir)
    } catch {}

    await fs.promises.mkdir(tmpdir)

    const store = new Corestore(tmpdir)

    const hypercoreStats = await HypercoreStats.fromCorestore(store, { cacheExpiryMs: 1000 })

    const drive = new Hyperdrive(store, key)
    const swarm = new Hyperswarm()
    swarm.on('connection', conn => {
      console.log('Opened connection')
      store.replicate(conn)
      conn.on('error', (e) => {
        console.log(`Connection error: ${e.stack}`)
      })
      conn.on('close', () => {
        console.log('Closed connection')
      })
    })

    const swarmStats = new HyperswarmStats(swarm)

    const tStart = performance.now()
    const printStats = () => {
      const elapsedSec = (performance.now() - tStart) / 1000
      const udxInfo = getUdxInfo(swarmStats, elapsedSec)
      const swarmInfo = getSwarmInfo(swarmStats)
      const hypercoreInfo = getHypercoreInfo(hypercoreStats)
      console.log(`Stats after ${elapsedSec.toFixed(2)} seconds:\n ${udxInfo}${swarmInfo}${hypercoreInfo}`)
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
    })

    await drive.ready()

    swarm.join(drive.discoveryKey, { server: false, client: true })
    if (drive.db.core.length <= 1) await once(drive.db.core, 'append') // DEVNOTE: in theory we could get a not-latest length, but 'good enough'

    console.info(`Downloading drive version ${drive.version}`)
    await drive.download('/', { wait: true })
    console.info('Drive fully downloaded')
    cancelling = false
  }
)

async function gcDir (dir) {
  await fs.promises.rm(dir, { recursive: true })
}

function getHypercoreInfo (stats) {
  return `Hypercore stats
  - Hotswaps: ${stats.totalHotswaps}
`
}

function getSwarmInfo (swarmStats) {
  const address = swarmStats.dhtStats.getRemoteAddress()
  const firewalled = swarmStats.dhtStats.isFirewalled
  return `Connection info
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
}

function getUdxInfo (swarmStats, elapsedSec) {
  const bytesRx = swarmStats.dhtStats.udxBytesReceived
  const bytesRxPerSec = (bytesRx / elapsedSec).toFixed(2)
  const bytesTx = swarmStats.dhtStats.udxBytesTransmitted
  const bytesTxPerSec = (bytesTx / elapsedSec).toFixed(2)
  const packetsRx = swarmStats.dhtStats.udxPacketsReceived
  const packetsRxPerSec = (packetsRx / elapsedSec).toFixed(2)
  const packetsTx = swarmStats.dhtStats.udxPacketsTransmitted
  const packetsTxPerSec = (packetsTx / elapsedSec).toFixed(2)

  const packetsDropped = swarmStats.dhtStats.udxPacketsDropped
  const packetsDroppedPerSec = (packetsDropped / elapsedSec).toFixed(2)

  return `UDX
  - Bytes received: ${byteSize(bytesRx)} (${byteSize(bytesRxPerSec)} / second)
  - Bytes transmitted: ${byteSize(bytesTx)} (${byteSize(bytesTxPerSec)} / second)
  - Packets received: ${packetsRx} (${packetsRxPerSec} / second)
  - Packets transmitted: ${packetsTx} (${packetsTxPerSec} / second)
  - Packets dropped: ${swarmStats.dhtStats.udxPacketsDropped} (${packetsDroppedPerSec} / second)
`
}

cmd.parse()
