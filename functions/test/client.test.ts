import { describe, expect, it } from 'vitest'
import { isTokenRejection } from '../src/hl/client.js'

describe('isTokenRejection', () => {
  it.each([
    [401, { message: 'Invalid JWT' }, true],
    [401, { message: 'Token expired' }, true],
    [401, null, true],
    [401, { message: 'version header is invalid' }, false],
    [401, { message: 'The token is not authorized for this scope.' }, false],
    [403, { message: 'Invalid JWT' }, false],
    [200, {}, false],
  ])('%i %j -> %s', (status, body, expected) => expect(isTokenRejection(status, body)).toBe(expected))
})
