import { describe, expect, it } from 'vitest'

import { containsPattern, escapeLike } from './like'

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character itself', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now')
  })

  it('leaves ordinary text alone and wraps contains-patterns', () => {
    expect(escapeLike('Jane Doe')).toBe('Jane Doe')
    expect(containsPattern('a_b')).toBe('%a\\_b%')
  })
})
