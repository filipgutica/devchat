/** The line icons the page uses, from the design system catalogue's sprite (components.html). */
export function IconSprite() {
  return (
    <svg className="sprite" aria-hidden="true" focusable="false">
      <symbol id="i-send" viewBox="0 0 16 16"><path d="M14.5 1.5 10 14.5l-2.5-6-6-2.5z" /><path d="M14.5 1.5l-7 7" /></symbol>
      <symbol id="i-check" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /><path d="M5.8 8.2l1.5 1.5 2.9-3" /></symbol>
      <symbol id="i-close" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></symbol>
      <symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></symbol>
      <symbol id="i-alert" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.5M8 10.8v.2" /></symbol>
    </svg>
  )
}

export const Icon = ({ name }: { name: 'send' | 'check' | 'close' | 'search' | 'alert' }) => (
  <svg className="icon" aria-hidden="true"><use href={`#i-${name}`} /></svg>
)
