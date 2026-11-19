/** Phones and tablets: the fullscreen button, and which side the notch is on. */

/**
 * On a phone or tablet, a way to give the clearing the whole screen (where the browser allows it:
 * not iPhone Safari, which keeps fullscreen for video). Landscape suits it, if the phone will turn.
 */
export function fullscreenButton(fullscreen: HTMLButtonElement) {
  fullscreen.hidden = !(matchMedia('(pointer: coarse)').matches && document.fullscreenEnabled)
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) return void document.exitFullscreen()
    // the browser may say no (and some phones won't turn): either way, nothing to do about it
    document.documentElement
      .requestFullscreen()
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
      .catch(() => {})
  })
  document.addEventListener('fullscreenchange', () => fullscreen.setAttribute('aria-pressed', String(!!document.fullscreenElement)))
}

/**
 * Which side the notch is on, held sideways: iOS pads both sides of the page alike, so the CSS can't
 * tell, but the turn can (90: turned anticlockwise, the top of the phone and its notch on the left).
 * page.css puts the scene on that side, under the notch, and the story on the other.
 * (Sets data-notch on the page: 'left' or 'right', or none when not held sideways.)
 */
export function markTheNotch() {
  const markNotch = () => {
    const turned = (window as Window & { orientation?: number }).orientation
    const side = turned === 90 ? 'left' : turned === -90 ? 'right' : undefined
    if (document.documentElement.dataset.notch === side) return
    if (side) document.documentElement.dataset.notch = side
    else delete document.documentElement.dataset.notch
  }
  // Turning from one side to the other doesn't resize the page, and iOS may only update the turn after
  // its events have fired: so check on every sign of a turn, again a moment later, and once a second
  // besides (one number read)
  const onTurn = () => {
    markNotch()
    setTimeout(markNotch, 250)
    setTimeout(markNotch, 800)
  }
  markNotch()
  addEventListener('orientationchange', onTurn)
  addEventListener('resize', onTurn)
  screen.orientation?.addEventListener('change', onTurn)
  setInterval(markNotch, 1000)
}
