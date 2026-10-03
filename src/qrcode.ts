/**
 * dsh-lan-guard — the access URL set and its QR codes.
 *
 * The QR is generated on the HOST, because only the host knows the real NIC
 * addresses and the passwordless token. It is emitted as an SVG string (the
 * researched dsh-mobile approach): no base64 bloat, and
 * the client can let it inherit theme colours.
 *
 * The token-bearing URL is a credential: it is only ever produced for an
 * admin-unlocked caller, and it is never logged.
 */
import QRCode from 'qrcode'
import { accessUrl, listNetworkAddresses, selectAddress, type NetworkAddress } from './network.ts'
import type { TlsMode } from './config.ts'

/** One address offered to the settings page. */
export interface AccessAddress {
  /** Interface name. */
  interface: string
  /** IPv4 literal. */
  address: string
  /** The URL a phone would open. */
  url: string
  /** Whether this looks like a virtual/tunnel adapter. */
  virtual: boolean
  /** Why it was classified as virtual. */
  virtualReason?: string
  /** Whether this is the address currently advertised. */
  selected: boolean
}

/** Everything the settings page needs to show a scannable link. */
/**
 * Why no QR code could be produced.
 *
 * A stable CODE rather than a sentence: the settings page owns the wording, so
 * the same condition reads correctly in either language and the host never
 * ships copy.
 */
export type AccessUnavailableCode = 'loopback-only' | 'no-address' | 'interface-missing'

export interface AccessInfo {
  /** Proxy port. */
  port: number
  /** The configured port, when the listener had to fall back to another one. */
  portFallbackFrom: number | null
  /** Whether the listener serves TLS. */
  secure: boolean
  /** The configured TLS mode. */
  tlsMode: TlsMode
  /** SHA-256 fingerprint of the CA, when a self-signed CA is in use. */
  caFingerprint: string | null
  /** Every candidate address, best first. */
  addresses: AccessAddress[]
  /** The advertised URL, or `null` when no address is usable. */
  selectedUrl: string | null
  /** QR for the advertised URL. */
  qrSvg: string | null
  /** The passwordless URL (admin-unlocked callers only). */
  tokenUrl?: string
  /** QR for the passwordless URL (admin-unlocked callers only). */
  tokenQrSvg?: string
  /** Why no URL is available, when that is the case. */
  /** Why no QR is available, when one is not. */
  unavailableReason?: AccessUnavailableCode
  /** The interface named by an `interface-missing` reason. */
  unavailableInterface?: string
  /** Whether the listener is loopback-only, so no LAN device can reach it. */
  loopbackOnly: boolean
}

/** Render one QR as an SVG string. */
export async function qrSvg(text: string): Promise<string> {
  return await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
}

/** Options for {@link buildAccessInfo}. */
export interface AccessInfoOptions {
  /** Proxy port. */
  port: number
  /** Resolved TLS mode. */
  tlsMode: TlsMode
  /** The address the listener is actually bound to. */
  listenHost: string
  /** When the configured port was taken, the port that was configured. */
  portFallbackFrom?: number | null
  /** Configured interface or address preference. */
  networkInterface?: string | null
  /** CA fingerprint to display, when known. */
  caFingerprint?: string | null
  /** The passwordless token; only pass it for an admin-unlocked caller. */
  secretToken?: string | null
  /** Injected address list (tests). */
  addresses?: readonly NetworkAddress[]
}

/**
 * Build the access information for the settings page.
 *
 * Rebuilt on every request on purpose: a NIC change, a TLS change, a port
 * change or a token rotation therefore refreshes the QR automatically.
 *
 * @param options - port, TLS mode and the optional token.
 * @returns the URL set plus QR codes.
 */
export async function buildAccessInfo(options: AccessInfoOptions): Promise<AccessInfo> {
  const secure = options.tlsMode !== 'off'
  const loopbackOnly = options.listenHost === '127.0.0.1' || options.listenHost === '::1'
  const candidates = [...(options.addresses ?? listNetworkAddresses())]
  const chosen = selectAddress(candidates, options.networkInterface ?? null)
  const addresses: AccessAddress[] = candidates.map(entry => ({
    interface: entry.interface,
    address: entry.address,
    url: accessUrl(entry.address, options.port, secure),
    virtual: entry.virtual,
    ...(entry.virtualReason === undefined ? {} : { virtualReason: entry.virtualReason }),
    selected: chosen !== undefined && entry.address === chosen.address,
  }))

  const info: AccessInfo = {
    port: options.port,
    portFallbackFrom: options.portFallbackFrom ?? null,
    secure,
    tlsMode: options.tlsMode,
    caFingerprint: options.caFingerprint ?? null,
    addresses,
    selectedUrl: loopbackOnly
      ? accessUrl('127.0.0.1', options.port, secure)
      : chosen === undefined ? null : accessUrl(chosen.address, options.port, secure),
    qrSvg: null,
    loopbackOnly,
  }

  if (loopbackOnly) {
    // A loopback URL is useless on a phone, so no QR is produced and the page
    // is told exactly why instead of being handed a scan that cannot work.
    info.unavailableReason = 'loopback-only'
    return info
  }

  if (chosen === undefined) {
    info.unavailableReason = options.networkInterface === null || options.networkInterface === undefined
      ? 'no-address'
      : 'interface-missing'
    if (options.networkInterface !== null && options.networkInterface !== undefined) {
      info.unavailableInterface = options.networkInterface
    }
    return info
  }

  info.qrSvg = await qrSvg(info.selectedUrl ?? '')
  const token = options.secretToken ?? null
  if (token !== null && token !== '' && info.selectedUrl !== null) {
    info.tokenUrl = `${info.selectedUrl}?auth=${token}`
    info.tokenQrSvg = await qrSvg(info.tokenUrl)
  }
  return info
}
