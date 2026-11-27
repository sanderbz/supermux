// The mode chip and the connection chip sit side by side in the desktop chat
// header and must share one geometry (they measured 25.25px vs 21px when the
// connection chip was an inline span). Both must carry the shared base class.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConnectionNote } from '../../src/components/chat/connection-note'
import { HEADER_CHIP_BASE } from '../../src/components/chat/header-chip'

describe('header chip parity', () => {
  test('the worded connection chip carries the shared chip geometry', () => {
    const html = renderToStaticMarkup(<ConnectionNote state="stale" />)
    for (const cls of HEADER_CHIP_BASE.split(' ')) expect(html).toContain(cls)
    expect(HEADER_CHIP_BASE).toContain('inline-flex')
  })
})
