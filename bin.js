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
// const HypercoreStats = require('hypercore-stats')
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

    // const hypercoreStats = await HypercoreStats.fromCorestore(store, { cacheExpiryMs: 1000 })

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
      const roundedSec = Math.round(elapsedSec)
      const stats = { ...swarmStats.asDict(), ...swarmStats.dhtStats.summary() }
      stats.elapsedTime = `${roundedSec} seconds`
      stats.bytesReceived = `${byteSize(stats.bytesReceived)} (${byteSize(stats.bytesReceived / elapsedSec)} / second)`
      stats.bytesTransmitted = `${byteSize(stats.bytesTransmitted)} (${byteSize(stats.bytesTransmitted / elapsedSec)} / second)`
      stats.packetsReceived = `${stats.packetsReceived} (${Math.round(stats.packetsReceived / elapsedSec)} / second)`
      stats.packetsTransmitted = `${stats.packetsTransmitted} (${Math.round(stats.packetsTransmitted / elapsedSec)} / second)`

      console.log('Stats overview:', stats)
      // console.log(hypercoreStats._getStats())
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

cmd.parse()
