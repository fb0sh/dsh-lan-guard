/**
 * Access URL + QR tests.
 *
 * The QR is a credential carrier when it holds the passwordless link, so the
 * rules tested here are: it is built from the CURRENT addresses, and the token
 * URL exists only when a token was supplied by an admin-unlocked caller.
 */
import { describe, expect, it } from 'vitest'
import type { NetworkAddress } from '../src/network.ts'
import { buildAccessInfo, qrSvg } from '../src/qrcode.ts'

const REAL: NetworkAddress = {
  interface: 'en0', address: '192.168.1.5', netmask: '255.255.255.0', virtual: false, rank: 0,
}
const VIRTUAL: NetworkAddress = {
  interface: 'utun3', address: '100.64.0.2', netmask: '255.255.255.255', virtual: true, virtualReason: 'VPN or tunnel', rank: 1,
}

describe('qrSvg', () => {
  it('renders an SVG string', async () => {
    const svg = await qrSvg('https://192.168.1.5:3445/')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).not.toContain('base64')
  })
})

describe('buildAccessInfo', () => {
  it('advertises the best address and its QR', async () => {
    const info = await buildAccessInfo({
      port: 3445,
      listenHost: '0.0.0.0',
      tlsMode: 'self-signed',
      addresses: [REAL, VIRTUAL],
    })
    expect(info.secure).toBe(true)
    expect(info.selectedUrl).toBe('https://192.168.1.5:3445/')
    expect(info.qrSvg).toContain('<svg')
    expect(info.addresses.find(entry => entry.interface === 'en0')?.selected).toBe(true)
    expect(info.addresses.find(entry => entry.interface === 'utun3')?.virtual).toBe(true)
  })

  it('honours an explicitly selected interface', async () => {
    const info = await buildAccessInfo({
      port: 3445,
      listenHost: '0.0.0.0',
      tlsMode: 'self-signed',
      networkInterface: 'utun3',
      addresses: [REAL, VIRTUAL],
    })
    expect(info.selectedUrl).toBe('https://100.64.0.2:3445/')
  })

  it('reports a configured interface that does not exist instead of guessing', async () => {
    const info = await buildAccessInfo({
      port: 3445,
      listenHost: '0.0.0.0',
      tlsMode: 'self-signed',
      networkInterface: 'en9',
      addresses: [REAL],
    })
    expect(info.selectedUrl).toBeNull()
    expect(info.qrSvg).toBeNull()
    // The host answers with a CODE, never with a sentence: the settings page
    // owns the wording, so the same condition reads correctly in either
    // language. The interface it names travels beside the code.
    expect(info.unavailableReason).toBe('interface-missing')
    expect(info.unavailableInterface).toBe('en9')
  })

  it('produces the passwordless URL and QR only when a token is supplied', async () => {
    const without = await buildAccessInfo({
      port: 3445, listenHost: '0.0.0.0', tlsMode: 'self-signed', addresses: [REAL],
    })
    expect(without.tokenUrl).toBeUndefined()
    expect(without.tokenQrSvg).toBeUndefined()

    const token = 'dsh_0123456789abcdef0123456789abcdef0123'
    const withToken = await buildAccessInfo({
      port: 3445, listenHost: '0.0.0.0', tlsMode: 'self-signed', addresses: [REAL], secretToken: token,
    })
    expect(withToken.tokenUrl).toBe(`https://192.168.1.5:3445/?auth=${token}`)
    expect(withToken.tokenQrSvg).toContain('<svg')
  })

  it('refuses to advertise a loopback listener as a scannable URL', async () => {
    const info = await buildAccessInfo({
      port: 3445, listenHost: '127.0.0.1', tlsMode: 'self-signed', addresses: [REAL],
    })
    expect(info.loopbackOnly).toBe(true)
    expect(info.qrSvg).toBeNull()
    expect(info.unavailableReason).toBe('loopback-only')
  })

  it('reflects the transport in the URL', async () => {
    const info = await buildAccessInfo({
      port: 3445, listenHost: '0.0.0.0', tlsMode: 'off', addresses: [REAL],
    })
    expect(info.selectedUrl).toBe('http://192.168.1.5:3445/')
    expect(info.secure).toBe(false)
  })
})
