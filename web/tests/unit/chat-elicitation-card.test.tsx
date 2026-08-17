/**
 * The MCP form card — what it puts on screen, and whose voice it is in.
 *
 * The failure this card exists to fix is a session parked forever on a dialog
 * nobody could see. The failure it must not INTRODUCE is subtler and worse: the
 * whole ask — the sentence, the field labels, the enum labels — is written by
 * whoever wrote the MCP server, and a card that renders it as its own words is
 * a phishing surface with supermux's chrome around it.
 *
 * So: attribution is asserted, plain-text rendering is asserted, and the
 * inertness of the actions is asserted with the reason attached to them.
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ElicitationAsk } from '../../src/components/chat/elicitation'
import { FormCard } from '../../src/components/chat/ui/form-card'

const ask = (over: Partial<ElicitationAsk> = {}): ElicitationAsk => ({
  server: 'deploy-bot',
  message: 'Confirm the production release',
  fields: [
    { name: 'approver', title: 'Approver email', kind: 'string', format: 'email', required: true },
    { name: 'builds', title: 'builds', kind: 'integer', required: false, minimum: 1, maximum: 5 },
    {
      name: 'env',
      title: 'env',
      kind: 'enum',
      required: true,
      options: [
        { value: 'prod', label: 'Production' },
        { value: 'staging', label: 'Staging' },
      ],
    },
    { name: 'notify', title: 'notify', kind: 'boolean', required: false, default: true },
  ],
  ...over,
})

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)

describe('the ask is attributed to the server that made it', () => {
  test('the server is named in the eyebrow, the question and under the quote', () => {
    const out = html(<FormCard ask={ask()} />)
    expect(out).toContain('MCP server')
    expect(out).toContain('deploy-bot needs your input')
    expect(out).toContain('from the MCP server')
    // Three separate mentions, because the sentence below them is not ours.
    expect(out.split('deploy-bot').length - 1).toBeGreaterThanOrEqual(3)
  })

  test("the server's own sentence is carried verbatim", () => {
    const out = html(<FormCard ask={ask()} />)
    expect(out).toContain('Confirm the production release')
  })

  test('third-party text is TEXT — no markup, no markdown, no link', () => {
    const hostile = ask({
      message: '<script>alert(1)</script> [click here](https://evil.example) **urgent**',
    })
    const out = html(<FormCard ask={hostile} />)
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    // Markdown is not interpreted: no anchor, and the asterisks stay literal.
    expect(out).not.toContain('<a ')
    expect(out).toContain('**urgent**')
  })
})

describe('the schema becomes controls a person can actually use', () => {
  test('each field gets a labelled control of its own type', () => {
    const out = html(<FormCard ask={ask()} />)
    expect(out).toContain('Approver email')
    // The enum is a selector carrying the server's own labels.
    expect(out).toContain('<select')
    expect(out).toContain('Production')
    expect(out).toContain('Staging')
    // The boolean is a checkbox, pre-filled from the schema's default.
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('checked=""')
    // The integer is numeric and carries its bounds.
    expect(out).toContain('type="number"')
    expect(out).toContain('min="1"')
    expect(out).toContain('max="5"')
  })

  test('required fields say so to a screen reader, not only with an asterisk', () => {
    const out = html(<FormCard ask={ask()} />)
    expect(out).toContain('(required)')
    expect(out).toContain('aria-required="true"')
  })

  test('a property no control can render is shown, named, and never enforced', () => {
    const odd = ask({ fields: [{ name: 'shards', title: 'shards', kind: 'unsupported', required: true }] })
    const out = html(<FormCard ask={odd} />)
    expect(out).toContain('shards')
    expect(out).toContain('isn’t one a form can show')
  })

  test('a form the server truncated says how much of it is missing', () => {
    const out = html(<FormCard ask={ask({ dropped_fields: 3 })} />)
    expect(out).toContain('4 of 7 fields shown')
  })

  test('a bare confirmation still draws its actions', () => {
    const out = html(<FormCard ask={ask({ fields: [] })} />)
    expect(out).toContain('Accept')
    expect(out).toContain('Decline')
    expect(out).toContain('Cancel')
  })
})

describe('the actions are honest about what they can do', () => {
  test('with no delivery lane they are disabled AND say why, reachably', () => {
    const reason = 'Answer in the terminal — supermux can read this form but not submit it yet.'
    const out = html(<FormCard ask={ask()} inertReason={reason} />)
    expect(out).toContain('disabled=""')
    // The reason rides INSIDE the button (part of its accessible name — a
    // disabled control is not a tab stop, so a `title=` would be unreachable)
    // and again as the sentence under the card.
    expect(out.split(reason).length - 1).toBeGreaterThanOrEqual(2)
  })

  test('given a lane, the buttons are live', () => {
    const out = html(<FormCard ask={ask()} onSubmit={() => {}} />)
    expect(out).not.toContain('disabled=""')
  })
})

describe('the card wears the dialog chrome, it does not fork it', () => {
  test('same shell, same eyebrow testid as the question card', () => {
    const out = html(<FormCard ask={ask()} />)
    expect(out).toContain('data-testid="chat-dialog-eyebrow"')
    expect(out).toContain('role="group"')
    // The one class string the whole dialog family shares.
    expect(out).toContain('ml-11 mt-3 max-w-[592px] rounded-[16px]')
  })
})
