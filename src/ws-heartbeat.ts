/**
 * dsh-lan-guard — WebSocket heartbeat answering for the upstream hop.
 *
 * Why this module exists (measured 2026-09-28, see README §「手机长时间挂起」):
 *
 * DSH's own mux server pings every WebSocket client every 2 s and terminates
 * the socket once two consecutive pings go unanswered
 * (`websocketHeartbeatIntervalMs: 2000`, `MAX_MISSED_HEARTBEATS: 2`). A phone
 * that leaves Safari, locks its screen or cannot run its page for a few seconds
 * therefore loses the socket after **6 s** — measured: a client that stops
 * sending Pongs is closed with code `1006` and no Close frame — and the shipped
 * chat UI needs that socket to load a session transcript (everything else it
 * shows arrives over HTTP). The user-visible result is «载入历史…» forever plus
 * a reconnect loop.
 *
 * The proxy sits between the two and can answer the upstream's Ping itself.
 * RFC 6455 explicitly allows an unsolicited Pong, and `ws` resets its missed
 * count on ANY Pong, so the visitor's own Pong arriving later is harmless.
 *
 * The observer is passive: the relay still pipes the raw bytes unchanged in
 * both directions and this module only reads a copy of the upstream→visitor
 * stream. It never accumulates a whole frame — at most 14 header bytes and, for
 * a Ping, its ≤125 byte payload — so a 2 MB snapshot frame costs it nothing.
 * Any anomaly turns it off permanently: the relay then behaves exactly as it
 * did before this module existed.
 */
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'

/** RFC 6455 Ping opcode. */
export const PING_OPCODE = 0x9
/** RFC 6455 Pong opcode. */
export const PONG_OPCODE = 0xa
/** A control frame's payload is at most 125 bytes. */
export const MAX_CONTROL_PAYLOAD = 125
/** Largest header this parser accumulates: 2 base + 8 extended length + 4 mask. */
const MAX_HEADER_BYTES = 14
/** A declared frame larger than this is garbage, not a frame. */
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** What the observer has seen so far. */
export interface PingAnswerStats {
  /** Complete frames observed upstream → visitor. */
  frames: number
  /** Ping frames observed. */
  pings: number
  /** Pongs written back to the upstream on the visitor's behalf. */
  answered: number
  /** Payload bytes carried by those Ping frames. */
  payloadBytes: number
}

/** One upstream-ping answerer. */
export interface UpstreamPingAnswerer {
  /**
   * Feed one chunk of the upstream→visitor stream.
   *
   * The chunk is only READ: the caller keeps piping the same bytes onward, so
   * this may be attached alongside `pipe`.
   */
  observe(chunk: Buffer): void
  /** Live counters. */
  stats(): PingAnswerStats
  /** Whether the observer is still parsing (false after an anomaly). */
  active(): boolean
}

/** Options for {@link createUpstreamPingAnswerer}. */
export interface PingAnswererOptions {
  /**
   * Write one already-framed, masked Pong to the upstream socket.
   *
   * The frame MUST be masked: RFC 6455 requires every client→server frame to be
   * masked and `ws` closes the connection with 1002 otherwise.
   */
  send(frame: Buffer): void
  /** Logger; one debug line is emitted when the observer disables itself. */
  logger?: LanGuardLogger
  /** Frame-size sanity bound; see {@link DEFAULT_MAX_FRAME_BYTES}. */
  maxFrameBytes?: number
}

/**
 * Build one masked client→server frame.
 *
 * @param opcode - the frame opcode.
 * @param payload - at most 125 bytes (control frames only).
 * @param mask - a 4-byte mask.
 * @returns the encoded frame.
 */
export function maskedFrame(opcode: number, payload: Buffer, mask: Buffer): Buffer {
  if (payload.length > MAX_CONTROL_PAYLOAD) {
    throw new RangeError('dsh-lan-guard: a control frame payload is at most 125 bytes')
  }
  const frame = Buffer.allocUnsafe(2 + 4 + payload.length)
  frame[0] = 0x80 | (opcode & 0x0f)
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return frame
}

/** Unmask a payload captured from a masked frame. */
function unmask(payload: Buffer, mask: Buffer | undefined): Buffer {
  if (mask === undefined || mask.length !== 4) return payload
  const copy = Buffer.from(payload)
  for (let index = 0; index < copy.length; index += 1) {
    copy[index] = (copy[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return copy
}

/**
 * Create the observer.
 *
 * @param options - see {@link PingAnswererOptions}.
 * @returns the observer; safe to call with any chunk, including garbage.
 */
export function createUpstreamPingAnswerer(options: PingAnswererOptions): UpstreamPingAnswerer {
  const logger = options.logger ?? noopLogger
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const counters: PingAnswerStats = { frames: 0, pings: 0, answered: 0, payloadBytes: 0 }

  /** Header bytes of the frame being parsed (never a payload). */
  let header: Buffer = Buffer.alloc(0)
  /** Total header bytes the current frame needs (2, then possibly more). */
  let headerNeed = 2
  /** Whether the parser is walking the payload of the current frame. */
  let inPayload = false
  /** Payload bytes still to walk. */
  let remaining = 0
  /** Captured Ping payload, when the frame is a Ping. */
  let captured: Buffer | undefined
  /** How many captured bytes were written so far. */
  let capturedAt = 0
  /** Current frame's opcode and mask key. */
  let opcode = 0
  let maskKey: Buffer | undefined
  let active = true

  const reset = (): void => {
    header = Buffer.alloc(0)
    headerNeed = 2
    inPayload = false
    remaining = 0
    captured = undefined
    capturedAt = 0
    maskKey = undefined
  }

  const disable = (reason: string): void => {
    if (!active) return
    active = false
    reset()
    logger.debug?.('upstream ping answerer disabled reason=%s', reason)
  }

  /** A fresh random mask per Pong, mirroring what a browser would send. */
  const freshMask = (): Buffer => {
    const mask = Buffer.allocUnsafe(4)
    for (let index = 0; index < 4; index += 1) mask[index] = Math.floor(Math.random() * 256)
    return mask
  }

  /** Current frame body finished: answer a Ping, then go back to header mode. */
  const finishFrame = (): void => {
    const isPing = opcode === PING_OPCODE
    const payload = isPing ? unmask(captured ?? Buffer.alloc(0), maskKey) : undefined
    reset()
    counters.frames += 1
    if (payload === undefined) return
    try {
      options.send(maskedFrame(PONG_OPCODE, payload, freshMask()))
      counters.answered += 1
    } catch (error) {
      disable(`pong write failed name=${(error as Error).name}`)
    }
  }

  return {
    observe(chunk: Buffer): void {
      if (!active || chunk.length === 0) return
      let cursor = 0
      while (cursor < chunk.length) {
        if (!inPayload) {
          const take = Math.min(headerNeed - header.length, chunk.length - cursor)
          header = header.length === 0
            ? chunk.subarray(cursor, cursor + take)
            : Buffer.concat([header, chunk.subarray(cursor, cursor + take)])
          cursor += take
          if (header.length < headerNeed) return
          if (headerNeed === 2) {
            // The first two bytes decide whether more header follows.
            const second = header[1] ?? 0
            const length7 = second & 0x7f
            const masked = (second & 0x80) !== 0
            const need = 2 + (length7 === 126 ? 2 : length7 === 127 ? 8 : 0) + (masked ? 4 : 0)
            if (need > header.length) {
              headerNeed = need
              continue
            }
          }
          opcode = (header[0] ?? 0) & 0x0f
          const second = header[1] ?? 0
          const length7 = second & 0x7f
          let length = length7
          let offset = 2
          if (length7 === 126) {
            length = header.readUInt16BE(2)
            offset = 4
          } else if (length7 === 127) {
            const declared = header.readBigUInt64BE(2)
            if (declared > BigInt(maxFrameBytes)) {
              disable('declared frame larger than the sanity bound')
              return
            }
            length = Number(declared)
            offset = 10
          }
          if ((second & 0x80) !== 0) {
            maskKey = header.subarray(offset, offset + 4)
            offset += 4
          } else {
            maskKey = undefined
          }
          if (length > maxFrameBytes) {
            disable('frame larger than the sanity bound')
            return
          }
          inPayload = true
          remaining = length
          if (opcode === PING_OPCODE) {
            counters.pings += 1
            counters.payloadBytes += length
            if (length > MAX_CONTROL_PAYLOAD) {
              disable('ping payload longer than 125 bytes')
              return
            }
            captured = Buffer.allocUnsafe(length)
            capturedAt = 0
          } else {
            captured = undefined
          }
          if (remaining === 0) finishFrame()
          continue
        }
        const take = Math.min(remaining, chunk.length - cursor)
        if (captured !== undefined) {
          chunk.copy(captured, capturedAt, cursor, cursor + take)
          capturedAt += take
        }
        remaining -= take
        cursor += take
        if (remaining === 0) finishFrame()
      }
    },
    stats: () => ({ ...counters }),
    active: () => active,
  }
}
