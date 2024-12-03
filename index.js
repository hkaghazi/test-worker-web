import { connect } from 'cloudflare:sockets';

let userID = '78829655-59f6-466b-897d-ea351d4ec82b';

const proxyIPs = [
  'mtn.ircf.space',
  'mkh.ircf.space',
  'mci.ircf.space',
  'rtl.ircf.space',
];
let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];

// let dohURL = 'https://dns.google/dns-query'; //'https://1.1.1.1/dns-query';
let dohURL = 'https://1.1.1.1/dns-query';
// (dohURL) list :
// https://cloudflare-dns.com/dns-query
// https://dns.google/dns-query
// https://sky.rethinkdns.com/1:-Pf_____9_8A_AMAIgE8kMABVDDmKOHTAKg=
// https://free.shecan.ir/dns-query        <--- دی ان اس ایرانی

if (!isValidUUID(userID)) throw new Error('uuid is invalid');

export default {
  /**
   * @param {import("@cloudflare/workers-types").Request} request
   * @param {{UUID: string, PROXYIP: string, DNS_RESOLVER_URL: string}} env
   * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      userID = env.UUID || userID;
      proxyIP = env.PROXYIP || proxyIP;
      dohURL = env.DNS_RESOLVER_URL || dohURL;

      let userID_Path = userID;
      if (userID.includes(',')) {
        userID_Path = userID.split(',')[0];
      }

      const upgradeHeader = request.headers.get('Upgrade');

      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        const url = new URL(request.url);
        switch (url.pathname) {
          case '/cf':
            return new Response(JSON.stringify(request.cf, null, 4), {
              status: 200,
              headers: { 'Content-Type': 'application/json;charset=utf-8' },
            });
          case '/connect': // for test connect to cf socket
            const [hostname, port] = ['cloudflare.com', '80'];
            console.log(`Connecting to ${hostname}:${port}...`);

            try {
              const socket = await connect({
                hostname: hostname,
                port: parseInt(port, 10),
              });

              const writer = socket.writable.getWriter();

              try {
                await writer.write(
                  new TextEncoder().encode(
                    'GET / HTTP/1.1\r\nHost: ' + hostname + '\r\n\r\n'
                  )
                );
              } catch (writeError) {
                writer.releaseLock();
                await socket.close();
                return new Response(writeError.message, { status: 500 });
              }

              writer.releaseLock();

              const reader = socket.readable.getReader();
              let value;

              try {
                const result = await reader.read();
                value = result.value;
              } catch (readError) {
                await reader.releaseLock();
                await socket.close();
                return new Response(readError.message, { status: 500 });
              }

              await reader.releaseLock();
              await socket.close();

              return new Response(new TextDecoder().decode(value), {
                status: 200,
              });
            } catch (connectError) {
              return new Response(connectError.message, { status: 500 });
            }

          default:
            // return new Response('Not found', { status: 404 });
            // For any other path, reverse proxy to 'www.fmprc.gov.cn' and return the original response
            url.hostname =
              Math.random() < 0.5 ? 'www.gov.cn' : 'www.fmprc.gov.cn';
            url.protocol = 'https:';
            request = new Request(url, request);
            return await fetch(request);
        }
      } else {
        return await vlOverWSHandler(request);
      }
    } catch (err) {
      /** @type {Error} */ let e = err;
      return new Response(e.toString());
    }
  },
};

/**
 * Handles VL over WebSocket requests by creating a WebSocket pair, accepting the WebSocket connection, and processing the VL header.
 * @param {import("@cloudflare/workers-types").Request} request The incoming request object.
 * @returns {Promise<Response>} A Promise that resolves to a WebSocket response object.
 */
async function vlOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  const log = (
    /** @type {string} */ info,
    /** @type {string | undefined} */ event
  ) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

  const readableWebSocketStream = makeReadableWebSocketStream(
    webSocket,
    earlyDataHeader,
    log
  );

  /** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
  let remoteSocketWapper = {
    value: null,
  };
  let udpStreamWrite = null;
  let isDns = false;

  // ws --> remote
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWapper.value) {
            const writer = remoteSocketWapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVlHeader(chunk, userID);
          address = addressRemote;
          portWithRandomLog = `${portRemote} ${isUDP ? 'udp' : 'tcp'} `;
          if (hasError) {
            // controller.error(message);
            throw new Error(message); // cf seems has bug, controller.error will not end stream
            // webSocket.close(1000, message);
            return;
          }

          // If UDP and not DNS port, close it
          if (isUDP && portRemote !== 53) {
            throw new Error('UDP proxy only enabled for DNS which is port 53');
            // cf seems has bug, controller.error will not end stream
          }

          if (isUDP && portRemote === 53) {
            isDns = true;
          }

          // ["version", "附加信息长度 N"]
          const vlResponseHeader = new Uint8Array([vlVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          // TODO: support udp here when cf runtime has udp support
          if (isDns) {
            const { write } = await handleUDPOutBound(
              webSocket,
              vlResponseHeader,
              log
            );
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }
          handleTCPOutBound(
            remoteSocketWapper,
            addressRemote,
            portRemote,
            rawClientData,
            webSocket,
            vlResponseHeader,
            log
          );
        },
        close() {
          log(`readableWebSocketStream is close`);
        },
        abort(reason) {
          log(`readableWebSocketStream is abort`, JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log('readableWebSocketStream pipeTo error', err);
    });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlResponseHeader The VL response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(
  remoteSocket,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  vlResponseHeader,
  log
) {
  /**
   * Connects to a given address and port and writes data to the socket.
   * @param {string} address The address to connect to.
   * @param {number} port The port to connect to.
   * @returns {Promise<import("@cloudflare/workers-types").Socket>} A Promise that resolves to the connected socket.
   */
  async function connectAndWrite(address, port) {
    /** @type {import("@cloudflare/workers-types").Socket} */
    const tcpSocket = connect({ hostname: address, port: port });
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData); // first write, nomal is tls client hello
    writer.releaseLock();
    return tcpSocket;
  }

  /**
   * Retries connecting to the remote address and port if the Cloudflare socket has no incoming data.
   * @returns {Promise<void>} A Promise that resolves when the retry is complete.
   */
  async function retry() {
    const tcpSocket = await connectAndWrite(
      proxyIP || addressRemote,
      portRemote
    );
    tcpSocket.closed
      .catch((error) => {
        console.log('retry tcpSocket closed error', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });
    remoteSocketToWS(tcpSocket, webSocket, vlResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);

  // when remoteSocket is ready, pass to websocket
  // remote--> ws
  remoteSocketToWS(tcpSocket, webSocket, vlResponseHeader, retry, log);
}

/**
 * Creates a readable stream from a WebSocket server, allowing for data to be read from the WebSocket.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer The WebSocket server to create the readable stream from.
 * @param {string} earlyDataHeader The header containing early data for WebSocket 0-RTT.
 * @param {(info: string)=> void} log The logging function.
 * @returns {ReadableStream} A readable stream that can be used to read data from the WebSocket.
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        const message = event.data;
        controller.enqueue(message);
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        controller.close();
      });

      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    pull(controller) {
      // if ws can stop read if stream is full, we can implement backpressure
      // https://streams.spec.whatwg.org/#example-rs-push-backpressure
    },

    cancel(reason) {
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });

  return stream;
}

/**
 * Processes the VL header buffer and returns an object with the relevant information.
 * @param {ArrayBuffer} vlBuffer The VL header buffer to process.
 * @param {string} userID The user ID to validate against the UUID in the VL header.
 * @returns {{
 *  hasError: boolean,
 *  message?: string,
 *  addressRemote?: string,
 *  addressType?: number,
 *  portRemote?: number,
 *  rawDataIndex?: number,
 *  vlVersion?: Uint8Array,
 *  isUDP?: boolean
 * }} An object with the relevant information extracted from the VL header buffer.
 */
function processVlHeader(vlBuffer, userID) {
  if (vlBuffer.byteLength < 24) {
    return { hasError: true, message: 'invalid data' };
  }
  const version = new Uint8Array(vlBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  const slicedBuffer = new Uint8Array(vlBuffer.slice(1, 17));
  const slicedBufferString = stringify(slicedBuffer);
  // check if userID is valid uuid or uuids split by , and contains userID in it otherwise return error message to console
  const uuids = userID.includes(',') ? userID.split(',') : [userID];
  console.log(slicedBufferString, uuids);

  // isValidUser = uuids.some(userUuid => slicedBufferString === userUuid.trim());
  isValidUser =
    uuids.some((userUuid) => slicedBufferString === userUuid.trim()) ||
    (uuids.length === 1 && slicedBufferString === uuids[0].trim());

  console.log(`userID: ${slicedBufferString}`);

  if (!isValidUser) {
    return {
      hasError: true,
      message: 'invalid user',
    };
  }

  const optLength = new Uint8Array(vlBuffer.slice(17, 18))[0];
  //skip opt for now

  const command = new Uint8Array(
    vlBuffer.slice(18 + optLength, 18 + optLength + 1)
  )[0];

  // 0x01 TCP
  // 0x02 UDP
  // 0x03 MUX
  if (command === 1) {
    isUDP = false;
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
    };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlBuffer.slice(portIndex, portIndex + 2);
  // port is big-Endian in raw data etc 80 == 0x005d
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(
    vlBuffer.slice(addressIndex, addressIndex + 1)
  );

  // 1--> ipv4  addressLength =4
  // 2--> domain name addressLength=addressBuffer[1]
  // 3--> ipv6  addressLength =16
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        vlBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(
        vlBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(
        vlBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      // 2001:0db8:85a3:0000:0000:8a2e:0370:7334
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      // seems no need add [] for ipv6
      break;
    default:
      return {
        hasError: true,
        message: `invild  addressType is ${addressType}`,
      };
  }
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlVersion: version,
    isUDP,
  };
}

/**
 * Converts a remote socket to a WebSocket connection.
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket The remote socket to convert.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to connect to.
 * @param {ArrayBuffer | null} vlResponseHeader The VL response header.
 * @param {(() => Promise<void>) | null} retry The function to retry the connection if it fails.
 * @param {(info: string) => void} log The logging function.
 * @returns {Promise<void>} A Promise that resolves when the conversion is complete.
 */
async function remoteSocketToWS(
  remoteSocket,
  webSocket,
  vlResponseHeader,
  retry,
  log
) {
  // remote--> ws
  let remoteChunkCount = 0;
  let chunks = [];
  /** @type {ArrayBuffer | null} */
  let vlHeader = vlResponseHeader;
  let hasIncomingData = false; // check if remoteSocket has incoming data
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() { },
        /**
         *
         * @param {Uint8Array} chunk
         * @param {*} controller
         */
        async write(chunk, controller) {
          hasIncomingData = true;
          remoteChunkCount++;
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error('webSocket.readyState is not open, maybe close');
          }
          if (vlHeader) {
            webSocket.send(await new Blob([vlHeader, chunk]).arrayBuffer());
            vlHeader = null;
          } else {
            console.log(`remoteSocketToWS send chunk ${chunk.byteLength}`);
            // seems no need rate limit this, CF seems fix this??..
            // if (remoteChunkCount > 20000) {
            // 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
            // 	await delay(1);
            // }
            webSocket.send(chunk);
          }
        },
        close() {
          log(
            `remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`
          );
          // safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
        },
        abort(reason) {
          console.error(`remoteConnection!.readable abort`, reason);
        },
      })
    )
    .catch((error) => {
      console.error(`remoteSocketToWS has exception `, error.stack || error);
      safeCloseWebSocket(webSocket);
    });

  // seems is cf connect socket have error,
  // 1. Socket.closed will have error
  // 2. Socket.readable will be close without any data coming
  if (hasIncomingData === false && retry) {
    log(`retry`);
    retry();
  }
}

/**
 * Decodes a base64 string into an ArrayBuffer.
 * @param {string} base64Str The base64 string to decode.
 * @returns {{earlyData: ArrayBuffer|null, error: Error|null}} An object containing the decoded ArrayBuffer or null if there was an error, and any error that occurred during decoding or null if there was no error.
 */
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { earlyData: null, error: null };
  }
  try {
    // go use modified Base64 for URL rfc4648 which js atob not support
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}

/**
 * Checks if a given string is a valid UUID.
 * Note: This is not a real UUID validation.
 * @param {string} uuid The string to validate as a UUID.
 * @returns {boolean} True if the string is a valid UUID, false otherwise.
 */
function isValidUUID(uuid) {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Closes a WebSocket connection safely without throwing exceptions.
 * @param {import("@cloudflare/workers-types").WebSocket} socket The WebSocket connection to close.
 */
function safeCloseWebSocket(socket) {
  try {
    if (
      socket.readyState === WS_READY_STATE_OPEN ||
      socket.readyState === WS_READY_STATE_CLOSING
    ) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

const byteToHex = [];

for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError('Stringified UUID is invalid');
  }
  return uuid;
}

/**
 * Handles outbound UDP traffic by transforming the data into DNS queries and sending them over a WebSocket connection.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket connection to send the DNS queries over.
 * @param {ArrayBuffer} vlResponseHeader The VL response header.
 * @param {(string) => void} log The logging function.
 * @returns {{write: (chunk: Uint8Array) => void}} An object with a write method that accepts a Uint8Array chunk to write to the transform stream.
 */
async function handleUDPOutBound(webSocket, vlResponseHeader, log) {
  let isVlHeaderSent = false;
  const transformStream = new TransformStream({
    start(controller) { },
    transform(chunk, controller) {
      // udp message 2 byte is the the length of udp data
      // TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPakcetLength)
        );
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
    flush(controller) { },
  });

  // only handle dns udp for now
  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const resp = await fetch(
            dohURL, // dns server url
            {
              method: 'POST',
              headers: {
                'content-type': 'application/dns-message',
              },
              body: chunk,
            }
          );
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          // console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
          const udpSizeBuffer = new Uint8Array([
            (udpSize >> 8) & 0xff,
            udpSize & 0xff,
          ]);
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`doh success and dns message length is ${udpSize}`);
            if (isVlHeaderSent) {
              webSocket.send(
                await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer()
              );
            } else {
              webSocket.send(
                await new Blob([
                  vlResponseHeader,
                  udpSizeBuffer,
                  dnsQueryResult,
                ]).arrayBuffer()
              );
              isVlHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log('dns udp has error' + error);
    });

  const writer = transformStream.writable.getWriter();

  return {
    /**
     *
     * @param {Uint8Array} chunk
     */
    write(chunk) {
      writer.write(chunk);
    },
  };
}