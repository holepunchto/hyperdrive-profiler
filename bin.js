#!/usr/bin/env node

const { once } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { command, flag } = require('paparam')
const goodbye = require('graceful-goodbye')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const HypercoreStats = require('hypercore-stats')
const HyperswarmStats = require('hyperswarm-stats')
const byteSize = require('tiny-byte-size')

const createTestnet = require('@hyperswarm/testnet')

let tStart = null
let secTillMetadata = null
let secTillFullyDownload = null
let statsInterval = null
let printIp = null
let detail = null
let hypercoreStats = null
let swarmStats = null

const cmd = command('hyperdrive-profiler',
  flag('--interval|-i [integer]', 'Interval (in seconds) at which to print the performance stats (default 10)'),
  flag('--ip', 'Print the IP address (obfuscated by default)'),
  flag('--detail', 'Include detailed stats'),
  flag('--local', 'User local DHT'),

  async function ({ flags }) {
    const statsIntervalMs = 1000 * (parseInt(flags.interval || 10))

    printIp = flags.ip
    detail = flags.detail

    const tmpdirServer = path.join(os.tmpdir(), `hyperdrive-profiler-tmp-${Math.random().toString(16).slice(2)}`)
    const tmpdirClient = path.join(os.tmpdir(), `hyperdrive-profiler-tmp-${Math.random().toString(16).slice(2)}`)
    console.info(`Printing progress every ${(statsIntervalMs / 1000).toFixed(0)} seconds`)

    try {
      await gcDir(tmpdirServer)
      await gcDir(tmpdirClient)
    } catch {}

    const testnet = await createTestnet(2)

    await fs.promises.mkdir(tmpdirServer)
    await fs.promises.mkdir(tmpdirClient)

    const storeServer = new Corestore(tmpdirServer)
    const storeClient = new Corestore(tmpdirClient)

    const driveServer = new Hyperdrive(storeServer)
    await driveServer.ready()

    const puts = []
    for (let i = 0; i < 2000; i++) puts.push(driveServer.put('/' + i, Buffer.alloc(1024 * 50)))
    await Promise.all(puts)

    const swarmServer = new Hyperswarm({ bootstrap: flags.local ? testnet.bootstrap : undefined })
    swarmServer.on('connection', conn => {
      storeServer.replicate(conn)
    })

    swarmServer.join(driveServer.discoveryKey, { server: true, client: false })
    await swarmServer.flush()

    const driveClient = new Hyperdrive(storeClient, driveServer.key)
    await driveClient.ready()

    const swarmClient = new Hyperswarm({ bootstrap: flags.local ? testnet.bootstrap : undefined })

    hypercoreStats = await HypercoreStats.fromCorestore(storeClient, { cacheExpiryMs: 1000 })
    swarmStats = new HyperswarmStats(swarmClient)

    swarmClient.on('connection', conn => {
      tStart = performance.now()
      statsInterval = setInterval(printStats, statsIntervalMs)
      storeClient.replicate(conn)
    })

    swarmClient.join(driveClient.discoveryKey, { server: false, client: true })

    if (driveClient.db.core.length <= 1) await once(driveClient.db.core, 'append') // DEVNOTE: in theory we could get a not-latest length, but 'good enough'
    secTillMetadata = (performance.now() - tStart) / 1000

    await driveClient.download('/', { wait: true })

    secTillFullyDownload = (performance.now() - tStart) / 1000

    goodbye(async () => {
      printStats(hypercoreStats, swarmServer)
      clearInterval(statsInterval)
      await swarmServer.destroy()
      await swarmClient.destroy()
      await storeServer.close()
      await storeClient.close()
      await gcDir(tmpdirServer)
      await gcDir(tmpdirClient)
    })

    goodbye.exit()
  }
)

async function gcDir (dir) {
  await fs.promises.rm(dir, { recursive: true })
}

function printStats () {
  const elapsedSec = (performance.now() - tStart) / 1000

  let timestampsInfo = `General\n  - Runtime: ${elapsedSec.toFixed(2)} seconds`
  timestampsInfo += '\n  - Metadata found in: '
  timestampsInfo += secTillMetadata
    ? `${secTillMetadata.toFixed(2).toString()} seconds`
    : 'unknown (still connecting...)'
  if (secTillFullyDownload) timestampsInfo += `\n  - Fully downloaded in ${secTillFullyDownload.toFixed(2)} seconds`

  const udxInfo = getUdxInfo(swarmStats, elapsedSec)
  const swarmInfo = getSwarmInfo(swarmStats, { printIp, detail })
  const hypercoreInfo = getHypercoreInfo(hypercoreStats, { detail })
  console.log(`${timestampsInfo}\n${udxInfo}${swarmInfo}${hypercoreInfo}`)
  console.log(`${'-'.repeat(50)}\n`)
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
