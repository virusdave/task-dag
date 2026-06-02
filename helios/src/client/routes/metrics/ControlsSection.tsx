// Shared collapsible page-controls section.
//
// Used by every scatter / time-range page to stack the Filters block
// above the Highlight block with consistent disclosure behaviour:
//   - `defaultOpen='always'`: always open by default (desktop AND
//     mobile). This is the Filters section on every page.
//   - `defaultOpen='desktop-only'`: open by default on desktop
//     (≥641px viewport) and collapsed by default on mobile. This is
//     the Highlight section, which is information-dense and pushes the
//     scatter off-screen on phones if forced open.
//
// The user can still click the `<summary>` to toggle either section on
// either device; the prop only controls the INITIAL state.
//
// Implementation: a `<details>` whose `open` attribute is set in a
// one-shot useEffect on mount based on window width. We deliberately
// avoid a CSS-only solution because `<details open>` can't be unset
// via CSS — only the chrome around it can be hidden, and we want a
// real collapse/expand affordance.
//
// See GitHub issue #38, task A2.
import { useEffect, useRef, type ReactNode } from 'react'

const MOBILE_MAX_WIDTH_PX = 640

export interface ControlsSectionProps {
  readonly title: string
  readonly defaultOpen: 'always' | 'desktop-only'
  readonly children: ReactNode
  /**
   * Optional extra className on the `<details>`. Adoption sites use
   * this to tag a section (e.g. `metrics-filters-section`) for any
   * page-specific tweaks.
   */
  readonly className?: string
}

export function ControlsSection({
  title,
  defaultOpen,
  children,
  className,
}: ControlsSectionProps) {
  const ref = useRef<HTMLDetailsElement | null>(null)
  // Default-open state is computed once on mount; we don't track
  // window resize because the user is allowed to manually toggle the
  // section after that and we'd clobber their choice on every resize.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const isDesktop =
      typeof window === 'undefined' ? true : window.innerWidth > MOBILE_MAX_WIDTH_PX
    el.open = defaultOpen === 'always' ? true : isDesktop
  }, [defaultOpen])
  const cls = ['metrics-controls-section', className].filter(Boolean).join(' ')
  return (
    <details
      ref={ref}
      className={cls}
      data-default-open={defaultOpen}
      // Render with the desktop-default initial value so SSR / first
      // paint don't flash closed-then-open on desktop. The mount
      // effect above corrects mobile.
      open={defaultOpen === 'always' ? true : true}
    >
      <summary className="metrics-controls-section-summary">{title}</summary>
      <div className="metrics-controls-section-body">{children}</div>
    </details>
  )
}
