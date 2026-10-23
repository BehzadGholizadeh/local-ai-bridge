// Runs inside the chat page (via Playwright's evaluate). It must be self-contained:
// no imports, no references to anything outside the function body.
//
// Returns the reply's HTML, normalized so a generic HTML → Markdown converter works:
// styled <span>s become <strong>/<em>, math becomes $TeX$, code blocks get their language
// as a class, UI controls are dropped, and preserved line breaks become <br>.

export function extractReplyHtml(el: Element, contentSelectors: string[]): string {
  let roots: Element[] = [];
  for (const s of contentSelectors) {
    roots = Array.from(el.querySelectorAll(s));
    if (roots.length) break;
  }
  if (!roots.length) roots = [el];

  return roots
    .map((root) => {
      const clone = root.cloneNode(true) as Element;
      const orig = [root, ...Array.from(root.querySelectorAll('*'))];
      const copy = [clone, ...Array.from(clone.querySelectorAll('*'))];
      const wraps: [Element, boolean, boolean][] = [];
      const math: [Element, string, boolean][] = [];
      const preWrap: Element[] = [];

      // Read computed styles first (needs the live elements), mutate the clone afterwards.
      orig.forEach((o, i) => {
        const c = copy[i];
        if (!c) return;
        const isMath = o.matches('[data-d-component="math"], .katex');
        if (isMath && !o.parentElement?.closest('[data-d-component="math"], .katex')) {
          const tex = o.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
          const display = !!o.closest('.katex-display') || getComputedStyle(o).display === 'block';
          if (tex) math.push([c, tex, display]);
          return;
        }
        const tag = o.tagName;
        if (tag === 'SPAN' && o.hasAttribute('data-d-inline') && !o.closest('a, code, pre')) {
          const st = getComputedStyle(o);
          const bold = Number(st.fontWeight) >= 600;
          const italic = st.fontStyle === 'italic';
          if (bold || italic) wraps.push([c, bold, italic]);
        }
        if (tag !== 'PRE' && tag !== 'CODE' && /^(pre-wrap|pre-line|break-spaces)$/.test(getComputedStyle(o).whiteSpace)) {
          preWrap.push(c);
        }
      });

      for (const [c, tex, display] of math) {
        c.replaceWith(document.createTextNode(display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`));
      }
      for (const [c, bold, italic] of wraps) {
        let node: Element = c;
        if (italic) {
          const em = document.createElement('em');
          node.replaceWith(em);
          em.appendChild(node);
          node = em;
        }
        if (bold) {
          const strong = document.createElement('strong');
          node.replaceWith(strong);
          strong.appendChild(node);
        }
      }
      // Line breaks kept as "\n" in text (white-space: pre-wrap) → <br>. Only inside inline
      // contexts: newlines between block elements are just markup formatting.
      for (const c of preWrap) {
        if (!/^(P|SPAN|LI|TD|TH|H[1-6]|A|STRONG|EM|B|I)$/.test(c.tagName)) continue;
        for (const t of Array.from(c.childNodes)) {
          if (t.nodeType !== Node.TEXT_NODE || !t.textContent?.includes('\n')) continue;
          const frag = document.createDocumentFragment();
          t.textContent.split('\n').forEach((line, i) => {
            if (i) frag.appendChild(document.createElement('br'));
            frag.appendChild(document.createTextNode(line));
          });
          t.replaceWith(frag);
        }
      }
      // Code blocks: move a short language label next to <pre> onto the <code> class.
      for (const pre of Array.from(clone.querySelectorAll('pre'))) {
        const label = Array.from(pre.parentElement?.children ?? []).find(
          (s) => s !== pre && s.tagName === 'SPAN' && !s.children.length && /^[\w+#.-]{1,24}$/.test(s.textContent?.trim() ?? ''),
        );
        const code = pre.querySelector('code');
        if (label && code && !/language-/.test(code.className)) {
          code.classList.add(`language-${label.textContent!.trim().toLowerCase()}`);
          label.remove();
        }
      }
      // Table cells: unwrap paragraphs so each cell stays on one line.
      for (const cell of Array.from(clone.querySelectorAll('td, th'))) {
        const ps = Array.from(cell.querySelectorAll('p'));
        ps.forEach((p, i) => {
          if (i) p.before(document.createElement('br'));
          p.replaceWith(...Array.from(p.childNodes));
        });
      }
      // List items with a single paragraph: unwrap it, otherwise the list renders "loose".
      for (const li of Array.from(clone.querySelectorAll('li'))) {
        // Layout <div> wrappers inside list items also make lists loose.
        for (const div of Array.from(li.querySelectorAll(':scope > div'))) {
          if (!div.querySelector('pre, table, ul, ol')) div.replaceWith(...Array.from(div.childNodes));
        }
        const ps = li.querySelectorAll('p');
        if (ps.length === 1 && !li.querySelector('ul, ol, pre, table')) ps[0].replaceWith(...Array.from(ps[0].childNodes));
      }
      for (const a of Array.from(clone.querySelectorAll('a[href]'))) {
        a.setAttribute('href', a.getAttribute('href')!.replace(/[?&]utm_source=chatgpt\.com$/, ''));
      }
      for (const junk of Array.from(clone.querySelectorAll('button, svg, [role="status"], [data-message-content-controls], [hidden]'))) {
        junk.remove();
      }
      // Links end with "&nbsp;<svg>" (an external-link icon); drop the leftover space.
      for (const a of Array.from(clone.querySelectorAll('a'))) {
        const last = a.lastChild;
        if (last?.nodeType === Node.TEXT_NODE) last.textContent = last.textContent!.replace(/[\s ]+$/, '');
      }
      return clone.innerHTML;
    })
    .join('\n');
}
