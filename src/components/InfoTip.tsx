import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';

/**
 * ⓘ help bubble. It opens on hover, on keyboard focus and on click/tap (so touch screens work),
 * closes on Escape or when focus and pointer leave, and is tied to its button with
 * aria-describedby so screen readers read the text with the control's name. The bubble stays in
 * the DOM (hidden) so the description is always available to assistive technology.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [shift, setShift] = useState(0);
  const bubble = useRef<HTMLSpanElement>(null);
  const open = hover || focus || pinned;
  // Keep the bubble inside the viewport (the trigger can sit near either screen edge).
  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const rect = bubble.current.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const current = shift;
    // The measured rect already includes the current shift; remove it to get the natural position.
    const left = rect.left - current;
    const right = rect.right - current;
    let next = 0;
    if (right > width - 8) next = width - 8 - right;
    if (left + next < 8) next = 8 - left;
    if (next !== current) setShift(next);
  }, [open, shift]);
  return (
    <span
      className="info-tip"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPinned(false);
      }}
    >
      <button
        type="button"
        className="info-tip-button"
        aria-label={`${label} 설명`}
        aria-describedby={id}
        aria-expanded={open}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false);
          setPinned(false);
        }}
        onClick={() => setPinned((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setHover(false);
            setPinned(false);
            setFocus(false);
          }
        }}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      <span
        ref={bubble}
        id={id}
        role="tooltip"
        className="info-tip-bubble"
        hidden={!open}
        style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      >
        {children}
      </span>
    </span>
  );
}
