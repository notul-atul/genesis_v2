import { describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../src/lib/crypto.js'
import { issuePreviewToken, readPreviewToken } from '../src/hl/previewToken.js'

const SECRET = 'test-secret-with-enough-entropy-0123456789'

describe('token encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('access-token', SECRET)
    expect(a).not.toBe(encrypt('access-token', SECRET))
    expect(decrypt(a, SECRET)).toBe('access-token')
  })

  it('fails with the wrong key', () => {
    expect(() => decrypt(encrypt('x', SECRET), 'other-secret')).toThrow()
  })
})

describe('preview tokens', () => {
  const claims = { uid: 'u1', pid: 'p1', loc: 'loc1' }

  it('verifies a fresh token', () => {
    const { token } = issuePreviewToken(claims, SECRET, 1_000)
    expect(readPreviewToken(token, SECRET, 2_000)).toMatchObject({ ...claims, typ: 'preview' })
  })

  it('rejects expired, tampered or foreign tokens', () => {
    const { token, expiresAt } = issuePreviewToken(claims, SECRET, 1_000)
    expect(readPreviewToken(token, SECRET, expiresAt + 1)).toBeNull()
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), uid: 'evil' })).toString('base64url')
    expect(readPreviewToken(`${forged}.${sig}`, SECRET, 2_000)).toBeNull()
    expect(readPreviewToken(token, 'other-secret', 2_000)).toBeNull()
  })
})
