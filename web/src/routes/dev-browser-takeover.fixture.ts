// Fixture for /dev/browser-takeover — an AUTHENTIC frame, captured offline.
//
// The base64 below is a real `Page.captureScreenshot` JPEG (512×384, q60) off
// the pinned `chrome-headless-shell` — the same encoder, size and quality the
// takeover screencast produces, so the bench exercises the real decode path
// rather than a hand-drawn stand-in. The page it shows is the takeover's own
// reason to exist: a sign-in + captcha the agent cannot get past.
//
// DEV-only and lazily imported by the route, so none of it reaches the
// production bundle (the same tree-shaking every other /dev/* fixture relies
// on).

import type { SocketLike, TakeoverOptions } from '@/lib/browser/takeover-socket'

/** One real JPEG frame, base64. */
export const RECORDED_FRAME =
  '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' +
  'vV6llbikkLc8Lo1yxpI6PRPetlS+tW6m/E5/skFpUydq1Gv6y60RLFcmHUkqKj43Wc1GORJHIjkTZdEXWBrK9yP/AJg9NjqeJfVS' +
  '6fFKhKiZsEKubA7LkSCR6vWyKtnIlk299znuoqZ6PR0d0e1GO6y60TYgkoqeSVZFa9r1+8rJHMzeKIqX+IRwpa+ratZI1IUhpVTq' +
  'uauZyWRV131bdwqq+rayrlpkgSOlTWkiKquWyLtRdW057qSBzJmuZdJ+01r1tVv0Q4WIYc6qe9rIomskajXSaZ6L8WIlne66hVc+' +
  'KVCTyMgivoWtVU0Ej86ql7IrdTfjc5WIS2wmSVYkW7UXJIi+7UpbJQ08j0erXtdZGq5kjmKqe+ypf4lksMc0KwyNzRqllS6hHDpH' +
  'VDsUrEdM1YmObZitXVdvct9XyJz1FQ6u9kpdExUj0jnyNV2pVsiIiKn6l/ssKVK1CI5JFSyqj3Ii+KXspiekhqHNfI1yPalkcx7m' +
  'OtuuiotiK4OIYjLSOdlfE9Ymor2JC9y+/rJqb8SU1bV6ar0OhSOnja/rNVVddL226thyJcNpJsySRuVHojXIkjkRyJsuiLr8S32W' +
  'BdL1O2ajX611oiWKOBiKzpQVFXDO5iPjYrW6+rr12199znuWeOlc5UbLM1qqiNTKjl7k2qSfBE+nWney8Sty5b9wZAxkGhRXqyyp' +
  '1pHOX5qtxJHdrG4pK2lmfIsbpmI20SxOiVquW2vMq3T3oQr6io0M9JVaJz0bHI18aKiWV6JZUVVNizD6VrZEWNz9ImVyyPc9VTdd' +
  'yqEw+lSN7NG5yPtmVz3OVbbNarcXCONNXzROngysWdJGthSy2cjtir4a7+BTJilRp5UhhV7IZMisSCRyvttVHJqTwNk+kgkqo6l8' +
  'aLNGio1111EX0VO+ZZcr2udrdkkc1HeKItl+IhXINTVwMZidO3TVDY5GyOentMiJqt/3avgbNkTGPe9qLeRbu1qvdb4EZKeGWRsk' +
  'jEc5qK1Lr3LtINZT173v9mc5skb4XKx6RyN2Jvd97btKqHEnswjTMjbo6aJrVat87nWS2ruT9TZx4fSxva9rHq5rVY1XSOdZq9yX' +
  'UylBSojU0KWbHo7XXW3cu/4lRRQVlRNO6KeNVblzJIkD40Rd3W2mwKYKWKnVVj0mtLdeVzrJ7rqti4SoACAAAK39ovgn1MGX9ovg' +
  'n1MFAABAAAAAAAAAAAAAAAAAAADLO0TwX6GDLO0TwX6AWAAiuLU1zaerggdG92lRy5mtc61vciKU02KRPlkincjXpM6NtmOtt1XX' +
  'YiltXBO6pp6inSNzosyK17laioqb0RdxStBKtJLEjmZn1OlRbra2ZF3bbIWElyHV9K2fQrL10cjV6q5UXcrrWRfdculmjhyaR2XO' +
  '5GN1bVU1i4U9JpUVqSxSSLIuapkZa63tlTUvoc3Ead9TRvjic1supzHO2I5FuhFGV9K9OpKjv6ixbF+/uKMOxSKqjia9yJO9F1I1' +
  'Uaqp3Iq6l+ZTS4VJBWQyK9ixMj6zdd1ktbN8lLYsPlZTUMSuZenfmfZV1pZU1aveXSORHX0sk2hZLdyqqIuVcqqm1Edayr4KI6+l' +
  'km0LJbuVVRFyrlVU2ojrWVfBThUuFPgdFG9qSRxOu161Ml/d1Pu3+IpMKfA+Jj2pJHE7M161Mnw6n3b/ABGhzsPnfU0bJpEajlVy' +
  'Wbs1KqfQ5BxKKCelp4YV0aoiuV63XvVVS2r3nLIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK39ovgn1MGX9ovgn1M' +
  'FAABAAAAAAAAAAAAAAAAAAADLO0TwX6GDLO0TwX6AWAAigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AK39ovgn1MGX9ovgn1MFAABAAAAAAAAAAAAAAAAAAADLO0TwX6GDLO0TwX6AWAAigNHjkHtGLYdH7JTVXVlXR1C2bsTX9136CRtX' +
  'HUw0dM+KgjbTPkWOnY1zUcjktZVamrXuQDeEZHsjY58j2sY1Lq5y2RENFS4hVxtp56yrzR1NI+ZzUjREiVqIvVtrXb33KP5lWtjr' +
  '4pHTrlpFnjWoZEjk2psbdLeKXLRbsjJI3uc1j2uVmpyIt7d+ska3C1vX4iq98kf/AMtpshKRNgAIoAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAArf2i+CfUwZf2i+CfUwUAAEAAAAAAAAAAAAAAAAAAAMs7RPBfoYMs7RPBfoBYACKoqaKkrEalXSwTo3' +
  '7uljR1vC5mGkpoGtbDTwxo1qtRGMRLIq3VNXdcsc61kRLuXYhi0vExP/ABXmBhKeBEYiQxojGq1vVTqtXaibkKo8PoYmubFR07Gu' +
  'blcjYmoipuXVsLrS8bPIvMWl42eReYGWRxsc5zGNar9blRLX7tZIhaXjZ5F5i0vGzyLzAmCFpeNnkXmLS8bPIvMCYIWl42eReYtL' +
  'xs8i8wJghaXjZ5F5i0vGzyLzAmCFpeNnkXmLS8bPIvMCYIWl42eReYtLxs8i8wJghaXjZ5F5i0vGzyLzAmCFpeNnkXmLS8bPIvMC' +
  'YIWl42eReYtLxs8i8wJghaXjZ5F5i0vGzyLzAmCFpeNnkXmLS8bPIvMCYIWl42eReYtLxs8i8wJghaXjZ5F5i0vGzyLzAmCFpeNn' +
  'kXmLS8bPIvMCYIWl42eReYtLxs8i8wJghaXjZ5F5i0vGzyLzAmCFpeNnkXmLS8bPIvMCYIWl4mL/AOK8zLXXuipZybUAkAAK39ov' +
  'gn1MGX9ovgn1MFAABAAAAAAAAAAAAAAAAAAADLO0TwX6GDLO0TwX6AWAAioJ27vc1P1UmQTt3/4t/VSSqiIqqtkTWoGQdSgxisbi' +
  'mHvhmr56CumWNH1UcDWORWqqKzJZ/d/cmwrrcRxd+EV2LQYloEhqlhZTpCxWo1siM1qqXzLt229wHcQdUrMSxqqxbEIMOjq0bRq1' +
  'jEgbArXuVqO6+kcjra/7beJe+bGKzG6ej9sdh6LQJNMyOON6pJmtZFcipYDsgOmMkq8Wq+j08ldNBM5Khjnwsj2t1K5Ec1dtidUj' +
  '8TrIo5m007555oo0rGq+KNkWrs0VEV7tt+QHcAdIwrFZKDD6memZE5raaeZ1PC9XRxujflarbqqojkvq2atRssGqMekq6Z9RFVyU' +
  's7FWZ8yU7Wxra6KzRuVypfVZb+IHZQdVwzFcRqekEmFS1kaxUKvfJUI1L1KdzbWsitv1re7ZchBjFY3FMPfDNXz0FdMsaPqo4Gsc' +
  'itVUVmSz+7+5NgjddydW7aDptVXY22ixTEYcUypSVqwxQLAxWK3MiWctsy7e5UOdJV4jQVGI0stc6pWOgWpikfExqsdrRUsiIipq' +
  'Rdd/iS9X56Wtbrz1p2QhDNFPEksEjJI3bHMciovxQ61QVmKQPwWWrxH2xmJNtJGsTGoxcivRWq1EW2qy3vt7jX0WIV8OF4Ph9A2e' +
  '9Q2d73wJEslmv2N0io3v9/gamKmkibd4IRzRTZ9FIx+Rysdlci5XJtRdynBwOTEn0b0xWF8crJFaxX5Mz2dyuRiq1F8Nxopa2vbD' +
  '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' +
  'AAAAAAAAADLO0TwX6GDLO0TwX6AWAAioudayIl3LsQxaXiYn/ivMJ27vc1P1UmBC0vGzyLzFpeNnkXmTAELS8bPIvMWl42eReYdN' +
  'CzPmlY3JbNdyJlvsvuJgQtLxs8i8xaXjZ5F5mc7NJo87c9r5b67b7EgIWl42eReYtLxs8i8yYAhaXjZ5F5i0vGzyLzJgCFpeNnkX' +
  'mLS8bPIvMmAIWl42eReYtLxs8i8yYAhaXjZ5F5i0vGzyLzJgCFpeNnkXmLS8bPIvMmAIWl42eReYtLxs8i8yYAhaXjZ5F5i0vGzy' +
  'LzJgCFpeNnkXmLS8bPIvMmAIWl42eReYtLxs8i8yYAhaXjZ5F5i0vGzyLzJgCFpeNnkXmLS8bPIvMmAIWl42eReYtLxs8i8yYAha' +
  'XjZ5F5i0vGzyLzJgCFpeNnkXmLS8bPIvMmAIWl4mL/4rzMtde6KlnJtQkQXt2+9q/qgEwABW/tF8E+pgy/tF8E+pgoAAIAAAAAAA' +
  'AAAAAAAAAAAAZZ2ieC/QwZZ2ieC/QCwAEVBO3f8A4t/VSa6kVUIJ27/8W/qpMDruGy5Ioa2qo0c6aXKtRpLvRVWyaram91r/AANt' +
  'iM0sfs8UD9G6eVGK+18qWVdV+/UTTD6VJklSNbo7OiZlyo7ejb2RfgW1FPFUxaOZmZt77VRUXeipsA0cqyw/zXPKkzmrFZzmN1p7' +
  '0tb0OTUT1cjq98NToW0qWa1GNXMuW91un6HMZhlGyOVjYltMqLJd7lV1tmtVucbE8NfVvfooof6jcrnuke1U8Wpqd8RJCiaWSZjs' +
  'zkRz8Pzq5Gtvfxt6Em+2QUdJo5ql8Lo0V7o42Oe3UlkRLbNvcqmyjo4WI3q5nNiSK6rtbusVphtKkaMakyI3Ulp33RNyLfZ7iz58' +
  'i6llbNSxyNk0iOT79rX+HcWkIYo4ImxRNRrGpZETuJkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIL27P8AF36oTIL27P8A' +
  'F36oBMAAVv7RfBPqYMv7RfBPqYKAACAAAAAAAAAAAAAAAAAAAGWdongv0MGWdongv0AsABFRcio7O1LraypvMaVve1/kUmAIaVu5' +
  '/kXkNK3c/wAi8iYAhpW7n+ReQ0rdz/IvImAIaVu5/kXkNK3c/wAi8iYAhpW7n+ReQ0rdz/IvImAIaVu5/kXkNK3c/wAi8iYAhpW7' +
  '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' +
  'n1MFAABAAAAAAAAH/9k='


/** Everything the bench's fake server sent, so a rig can assert on the input
 *  the panel produced without a browser on the other end. */
export const MOCK_SENT: string[] = []

/**
 * A fake takeover socket that answers the real handshake with the real frames:
 * `auth_ok` → `target` → `mode` → one JPEG. Input frames are recorded in
 * [`MOCK_SENT`] and `hand_back` / `take_over` flip the mode for real, so the
 * pill and the read-only state are exercised end to end with no server.
 */
export function mockOptions(mode: 'human_driving' | 'agent_driving' = 'human_driving'): TakeoverOptions {
  return {
    token: () => 'bench',
    baseUrl: () => 'ws://bench',
    factory: () => {
      let live = mode
      const sock: SocketLike = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(raw: string) {
          MOCK_SENT.push(raw)
          const msg = JSON.parse(raw) as { type: string }
          if (msg.type === 'auth') {
            sock.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) })
            sock.onmessage?.({
              data: JSON.stringify({
                type: 'target',
                session: 'bench',
                url: 'https://example.internal/sign-in',
              }),
            })
            sock.onmessage?.({ data: JSON.stringify({ type: 'mode', mode: live }) })
            sock.onmessage?.({
              data: JSON.stringify({
                type: 'frame',
                data: RECORDED_FRAME,
                metadata: {
                  offsetTop: 0,
                  pageScaleFactor: 1,
                  deviceWidth: 512,
                  deviceHeight: 384,
                  scrollOffsetX: 0,
                  scrollOffsetY: 0,
                },
              }),
            })
          }
          if (msg.type === 'hand_back' || msg.type === 'take_over') {
            live = msg.type === 'hand_back' ? 'agent_driving' : 'human_driving'
            sock.onmessage?.({ data: JSON.stringify({ type: 'mode', mode: live }) })
          }
        },
        close() {
          sock.onclose?.({ code: 1000, reason: 'done' })
        },
      }
      // The real socket's `onopen` fires asynchronously; mirror that so the
      // panel's mount ordering is the one production sees.
      queueMicrotask(() => sock.onopen?.({}))
      return sock
    },
  }
}
