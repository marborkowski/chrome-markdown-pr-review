// Diagram markup is repository content under review: mermaid's sanitiser (securityLevel
// 'strict') drops scripts but keeps links and form controls, which must not act inside the
// review UI. Runs in the browser only (DOM); keep it out of the pure diff helpers.

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(https?|mailto):/i;

export const linkHref = (a: Element) => a.getAttribute('xlink:href') ?? a.getAttribute('href') ?? '';

/**
 * Strips form controls and unwraps links with no or an unsafe target (javascript:, data:,
 * protocol-relative); the links kept open in a new tab, and the diagram wrapper's delegated
 * click handler resolves them like document links. Returns the cleaned markup.
 */
export function hardenSvg(svg: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = svg;
  for (const el of tpl.content.querySelectorAll('form, input, button, select, textarea')) el.remove();
  for (const a of tpl.content.querySelectorAll('a')) {
    const href = linkHref(a);
    if (!href || href.startsWith('//') || (HAS_SCHEME.test(href) && !SAFE_SCHEME.test(href))) {
      a.replaceWith(...a.childNodes);
      continue;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  return tpl.innerHTML;
}
