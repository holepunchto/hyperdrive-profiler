# Hyperdrive Profiler

Profile [Hyperdrive](https://github.com/holepunchto/hyperdrive) download performance.

The current major (v2) works for Hyperdrive v13. The old major (v1) works for Hyperdrive v11.

## Install

```
npm i -g hyperdrive-profiler
```

## Usage

```
hyperdrive-profiler <drive key>
```

Note: for running with bare, use `hyperdrive-profiler-bare`,

This downloads the Hyperdrive with the given key to a temporary folder, and displays performance and progress metrics.

To see all options, run
```
hyperdrive-profiler --help
```

Example output:
```
General
  - Runtime: 97.95 seconds
  - Metadata found in: 0.80 seconds
  - Fully downloaded in 97.95 seconds
Network (UDX)
  - Bytes received: 1.6GB (15.8MB / second)
  - Bytes transmitted: 4.2MB (43.3kB / second)
  - Packets received: 1086078 (11089 / second)
  - Packets transmitted: 178622 (1824 / second)
  - Packets dropped: 0 (0.00 / second)
Connection info
  - Address: xxx.xxx.xxx.xxx (firewalled: true)
  - Connections:
    - Attempted: 5
    - Opened: 5
    - Closed: 0
  - Connection issues:
    - Retransmission timeouts: 0
    - Fast recoveries: 4
    - Retransmits: 4
Hypercore stats
  - Hotswaps: 288
```
