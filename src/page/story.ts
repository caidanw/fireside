/**
 * The village's story, as a log: the newest line arrives at the top and pushes the older ones down,
 * where the last two fade away. Each line is spelled out a letter at a time; lines that arrive
 * together wait their turn, so the typing itself sets the pace. It keeps the scene's time: held
 * (before the visitor begins, and while they pause), the typing stops, mid-line if need be, and
 * carries on from the same letter.
 */
export function storyLog(story: HTMLElement) {
  const queue: string[] = []
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  let telling = false
  let held = true
  const waiting: (() => void)[] = []
  const later = (ms: number, fn: () => void) => window.setTimeout(() => (held ? waiting.push(fn) : fn()), ms)
  function showNext() {
    const line = queue.shift()
    telling = line !== undefined
    if (line === undefined) return
    // lines pushed past the bottom (through the fade) are gone
    for (const old of [...story.children] as HTMLElement[]) if (old.offsetTop >= story.clientHeight) old.remove()
    // the whole line is laid out from the start (the untyped part invisible), so words don't jump
    // between rows as it types; screen readers get the line once, whole
    const item = document.createElement('li')
    const heard = Object.assign(document.createElement('span'), { className: 'heard', textContent: line })
    const typed = document.createElement('span')
    const rest = Object.assign(document.createElement('span'), { className: 'rest', textContent: line })
    typed.ariaHidden = rest.ariaHidden = 'true'
    item.append(heard, typed, rest)
    story.prepend(item)
    requestAnimationFrame(() => requestAnimationFrame(() => item.classList.add('shown')))
    let i = still.matches ? line.length : 0
    const type = () => {
      typed.textContent = line.slice(0, i)
      rest.textContent = line.slice(i)
      if (i >= line.length) return void later(900, showNext)
      const c = line[i++]
      later(32 + (c === ',' ? 160 : c === '.' && i < line.length ? 320 : 0), type)
    }
    type()
  }
  return {
    tell(line: string) {
      queue.push(line)
      if (!held && !telling) showNext()
    },
    hold(h: boolean) {
      held = h
      if (h) return
      for (const fn of waiting.splice(0)) fn()
      if (!telling) showNext()
    },
  }
}
