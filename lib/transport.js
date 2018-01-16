const ip = require('ip')
const Packet = require('./packet')

const IP_TTL = 0x40 // 64
const SCTP_PROTO = 0x84 // 132 - see https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xhtml
const SO_RCVBUF = 1024 * 128
const SO_SNDBUF = SO_RCVBUF
const BUFFER_SIZE = 1024 * 4

let raw = null
let rawtransport = null

let log = () => {
  // dummy logger can be enabled later
}

function setLogger(logger) {
  if (logger && (typeof logger.log === 'function')) {
    log = (level, ...rest) => {
      logger.log(level, 'transport -', ...rest)
    }
  } else {
    log = function () {
    }
  }
}

let transports = new WeakMap()

class Transport {
  constructor() {
    this.pool_start = 0xC000
    this.pool_finish = 0xFFFF
    this.pool_size = this.pool_finish - this.pool_start
    this.pool = {}
    this.pointer = this.pool_start
    this.countRcv = 0
  }

  register(endpoint) {
    endpoint.localPort = this.allocate(endpoint.localPort)
    if (endpoint.localPort) {
      this.pool[endpoint.localPort] = endpoint
      log('debug', 'endpoint registered on port', endpoint.localPort)
      return endpoint
    }
  }

  allocate(desired) {
    if (desired > 0 && desired < 0xffff) {
      if (desired in this.pool) {
        return null
      } else {
        return desired
      }
    } else {
      let attempt = 0
      while (this.pointer in this.pool) {
        this.log('trace', 'attempt', attempt)
        attempt++
        if (attempt > this.pool_size) return null
        this.pointer++
        if (this.pointer > this.pool_finish) {
          this.pointer = this.pool_start
        }
      }
      return this.pointer
    }
  }

  unallocate(port) {
    delete this.pool[port]
    log('debug', 'unallocated port', port)
  }

  receivePacket(packet, source, destination) {
    if (packet && packet.chunks) {
      log('debug', '< sctp packet', packet.chunks.length, 'chunks', destination, packet.dst_port, '<-', source, packet.src_port)
      let endpoint = this.pool[packet.dst_port]
      if (endpoint) {
        log('trace', 'emit packet to endpoint', endpoint.localPort)
        endpoint.emit('packet', packet, source, destination)
      } else {
        log('trace', 'OOTB message', packet)
      }
    } else {
      log('warn', 'sctp packet decode error')
    }
  }
}

class RawTransport extends Transport {
  constructor(options) {
    super()

    options = options || {}
    log('info', 'opening raw socket', options)

    let rawsocket = raw.createSocket({
      addressFamily: raw.AddressFamily.IPv4,
      protocol: SCTP_PROTO,
      bufferSize: BUFFER_SIZE
    })

    rawsocket.setOption(raw.SocketLevel.IPPROTO_IP, raw.SocketOption.IP_TTL, IP_TTL)
    rawsocket.setOption(raw.SocketLevel.SOL_SOCKET, raw.SocketOption.SO_RCVBUF, SO_RCVBUF)
    rawsocket.setOption(raw.SocketLevel.SOL_SOCKET, raw.SocketOption.SO_SNDBUF, SO_SNDBUF)

    // workaround to start listening on win32 // todo
    if (process.platform === 'win32') {
      rawsocket.send(Buffer.alloc(20), 0, 0, '127.0.0.1', null, () => {
      })
    }
    log('info', 'raw socket opened on', process.platform, 'platform')

    if (options.icmp) {
      setTimeout(_ => {
        this.enableICMP()
      }, 0)
    }

    rawsocket.on('message', (buffer, source) => {
      this.countRcv++
      log('debug', '< message', buffer.length, 'bytes from', source, 'total', this.countRcv)
      if (buffer.length < 36) return // less than ip header + sctp header

      const headerLength = (buffer[0] & 0x0f) << 2
      // const protocol = buffer[9]
      let destination = ip.toString(buffer, 16, 4)
      let packetLength = readLength(buffer)
      if (!checkLength(buffer, headerLength, packetLength)) return
      log('trace', '< ip packet ok', destination, '<-', source)
      let payload = buffer.slice(headerLength)

      let packet = Packet.fromBuffer(payload)
      this.receivePacket(packet, source, destination)
    })

    this.rawsocket = rawsocket
  }

  enableICMP() {
    log('info', 'starting ICMP RAW socket on', process.platform)

    this.icmpsocket = raw.createSocket({
      addressFamily: raw.AddressFamily.IPv4,
      protocol: 1
    })

    // this.icmpsocket.send(Buffer.alloc(42), 0, 0, '192.168.1.1', null, () => {
    //   // todo ?
    //   log('info', 'ICMP socket opened', process.platform)
    // })

    this.icmpsocket.on('message', function (buffer, source) {
      log('trace', '< ICMP from', source)
      if (buffer.length < 42) return  // size < ip header + ICMP header + 8 = 20 + 16 + 8 = 42
      const headerLength = (buffer[0] & 0x0f) << 2
      let packetLength = readLength(buffer)
      if (!checkLength(buffer, headerLength, packetLength)) return
      let payload = buffer.slice(headerLength)
      this.processICMPPacket(payload)
    })
  }

  processICMPPacket(buffer) {
    /*

     https://tools.ietf.org/html/rfc792

      0                   1                   2                   3
      0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     |     Type      |     Code      |          Checksum             |
     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     |                             unused                            |
     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     |      Internet Header + 64 bits of Original Data Datagram      |
     +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

    */

    let type = buffer[0]
    if (type !== 3) {
      // An implementation MAY ignore all ICMPv4 messages where the type field is not set to "Destination Unreachable"
      return
    }

    let code = buffer[1]
    /*
     An implementation MAY ignore any ICMPv4 messages where the code does not indicate "Protocol Unreachable" or "Fragmentation Needed".

     Code
        0 = net unreachable;
        1 = host unreachable;
        2 = protocol unreachable;
        3 = port unreachable;
        4 = fragmentation needed and DF set;
        5 = source route failed.
    */
    if (code !== 2 && code !== 4) return
    let payload = buffer.slice(8)

    this.processICMPPayload(payload, code)
  }

  processICMPPayload(buffer, code) {
    const headerLength = (buffer[0] & 0x0f) << 2
    const protocol = buffer[9]
    if (protocol !== SCTP_PROTO) return
    let destination = ip.toString(buffer, 16, 4)
    let source = ip.toString(buffer, 12, 4)

    let packet = Packet.fromBuffer(buffer.slice(headerLength))
    if (packet) {
      let endpoint = this.pool[packet.src_port]
      if (endpoint) {
        if (code === 2) {
          log('debug', '< ICMP Protocol Unreachable for SCTP packet', packet.src_port, '->', destination, ':', packet.dst_port)
          endpoint.emit('icmp', packet, source, destination, code)
        }
      } else {
        // If the association cannot be found, an implementation SHOULD ignore the ICMP message.
      }
    }
  }

  sendPacket(local, remote, packet, callback) {
    let payload = packet.toBuffer()
    log('debug', '> send', packet.chunks.length, 'chunk',
      local, ':', packet.src_port, '->', remote, packet.dst_port, ':', payload.length, 'bytes')
    let buffer
    let cb = (error, bytes) => {
      if (error) {
        log('error', 'raw socket send error', error)
      } else {
        log('trace', 'raw socket sent', bytes, 'bytes')
      }
      if (typeof callback === 'function') {
        callback(error)
      }
    }

    let beforeSend
    if (local) {
      beforeSend = () => this.rawsocket.setOption(raw.SocketLevel.IPPROTO_IP, raw.SocketOption.IP_HDRINCL, 1)
      let headerBuffer = createHeader({local, remote, payload})
      log('trace', headerBuffer)
      let checksum = raw.createChecksum(headerBuffer)
      raw.writeChecksum(headerBuffer, 10, checksum)
      buffer = Buffer.concat([headerBuffer, payload])
    } else {
      beforeSend = () => this.rawsocket.setOption(raw.SocketLevel.IPPROTO_IP, raw.SocketOption.IP_HDRINCL, 0)
      buffer = payload
    }
    this.rawsocket.send(buffer, 0, buffer.length, remote, beforeSend, cb)
    return true
  }
}

class UDPTransport extends Transport {
  constructor(udpTransport) {
    super()

    this.socket = udpTransport

    this.socket.on('close', () => {
      log('error', 'transport was closed')
      for (let port in this.pool) {
        let endpoint = this.pool[port]
        endpoint.close()
      }
      delete this.socket
      delete transports[this.socket]
    })

    this.socket.on('message', (buffer) => {
      this.countRcv++
      log('debug', '< message', buffer.length, 'total', this.countRcv)
      if (buffer.length < 20) return // less than sctp header

      let packet = Packet.fromBuffer(buffer)
      this.receivePacket(packet)
    })
  }

  sendPacket(local, remote, packet, callback) {
    let buffer = packet.toBuffer()
    log('debug', '> send', packet.chunks.length, 'chunk',
      local, ':', packet.src_port, '->', remote, packet.dst_port, ':', buffer.length, 'bytes')
    this.socket.send(buffer, 0, buffer.length, callback)
    return true
  }
}

const checkLength = (process.platform === 'darwin') ?
  function (buffer, headerLength, packetLength) {
    return buffer.length === packetLength + headerLength
  } :
  function (buffer, headerLength, packetLength) {
    return buffer.length === packetLength
  }

const readLength = (process.platform === 'darwin') ?
  function (buffer) {
    return buffer.readUInt16LE(2)
  } :
  function (buffer) {
    return buffer.readUInt16BE(2)
  }

const writeLength = (process.platform === 'darwin') ?
  function (buffer, value) {
    buffer.writeUInt16LE(value, 2)
  } : function (buffer, value) {
    buffer.writeUInt16BE(value, 2)
  }

function createHeader(packet) {
  let buffer = Buffer.from(Buffer.from([
    0x45, // version and header length
    0x00, // dfs
    0x00, 0x00, // packet length
    0x00, 0x00, // id
    0x00, // flags
    0x00, // offset
    IP_TTL,
    SCTP_PROTO,
    0x00, 0x00, // checksum
    0x00, 0x00, 0x00, 0x00, // source address
    0x00, 0x00, 0x00, 0x00 // destination address
  ]))
  writeLength(buffer, buffer.length + packet.payload.length)
  if (packet.ttl > 0 && packet.ttl < 0xff) buffer.writeUInt8(packet.ttl, 8)
  if (packet.local) {
    ip.toBuffer(packet.local, buffer, 12)
  }
  ip.toBuffer(packet.remote, buffer, 16)
  return buffer
}

function register(endpoint) {
  if (endpoint.udpTransport) {
    if (transports.has(endpoint.udpTransport)) {
      endpoint.transport = transports.get(endpoint.udpTransport)
    } else {
      endpoint.transport = new UDPTransport(endpoint.udpTransport)
      transports.set(endpoint.udpTransport, endpoint.transport)
    }
  } else {
    if (!rawtransport) {
      rawtransport = new RawTransport()
    }
    endpoint.transport = rawtransport
  }
  return endpoint.transport.register(endpoint)
}


module.exports = {
  register,
  setLogger,
  raw: function (module) {
    raw = module
  }
}