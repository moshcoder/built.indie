// built.indie: vote without a page load, copy buttons, progress while we read a site, the service worker.
// A share button: tell the server before the share window opens (a signed-in member earns karma).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-share]')
  const slug = btn?.closest('[data-share-slug]')?.dataset.shareSlug
  if (!btn || !slug) return
  const url = '/p/' + encodeURIComponent(slug) + '/share?net=' + encodeURIComponent(btn.dataset.share)
  if (!(navigator.sendBeacon && navigator.sendBeacon(url))) fetch(url, { method: 'POST', keepalive: true }).catch(() => {})
}, true)
document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]')
  if (copy) {
    e.preventDefault()
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
      const was = copy.textContent
      copy.textContent = 'Copied'
      setTimeout(() => { copy.textContent = was }, 1500)
    })
    return
  }
  const vote = e.target.closest('[data-vote]')
  if (!vote) return
  e.preventDefault()
  if (vote.classList.contains('voted')) return
  vote.classList.add('voted', 'bump')
  const count = vote.querySelector('.count')
  count.textContent = String(Number(count.textContent) + 1)
  try {
    const r = await fetch('/p/' + encodeURIComponent(vote.dataset.vote) + '/vote', { method: 'POST', headers: { accept: 'application/json' } })
    if (r.ok) count.textContent = String((await r.json()).votes)
  } catch {}
})
document.addEventListener('submit', (e) => {
  const form = e.target
  if (form.dataset.confirm && !confirm(form.dataset.confirm)) return e.preventDefault()
  if (!form.dataset.busy || form.classList.contains('busy')) return
  form.classList.add('busy')
  const note = document.createElement('p')
  note.className = 'busy-note'
  note.textContent = form.dataset.busy
  form.append(note)
})
// Search, on every page: "/" jumps to it; typing suggests launches (Enter still opens the full results).
const box = document.querySelector('[data-suggest]')
if (box) {
  const input = box.querySelector('input')
  const list = box.querySelector('.suggest')
  let timer, seq = 0
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const items = () => [...list.querySelectorAll('a')]
  const close = () => { list.hidden = true; input.removeAttribute('aria-activedescendant') }
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return
    e.preventDefault()
    input.focus()
    input.select()
  })
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) return close()
    timer = setTimeout(async () => {
      const mine = ++seq
      try {
        const r = await (await fetch('/api/v1/search?facets=0&limit=6&q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } })).json()
        if (mine !== seq) return
        list.innerHTML = r.products.map((p) => `<a href="/p/${esc(p.slug)}" role="option">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : `<b class="logo logo-letter">${esc(p.name.slice(0, 1).toUpperCase())}</b>`}<span><b>${esc(p.name)}</b><small>${esc(p.tagline || p.domain)}</small></span></a>`).join('') + `<a class="all" href="/search?q=${encodeURIComponent(q)}" role="option">${r.total ? `All ${r.total} result${r.total === 1 ? '' : 's'} for “${esc(q)}” →` : `No launches match “${esc(q)}”. Browse everything →`}</a>`
        list.hidden = false
      } catch {}
    }, 140)
  })
  input.addEventListener('keydown', (e) => {
    const all = items()
    if (list.hidden || !all.length) return
    const at = all.findIndex((a) => a.getAttribute('aria-selected') === 'true')
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = all[at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length]
      all.forEach((a) => a.removeAttribute('aria-selected'))
      next.setAttribute('aria-selected', 'true')
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault()
      location.href = all[at].href
    } else if (e.key === 'Escape') close()
  })
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) close() })
}
// Browse: sorting applies at once; on a phone the filters start folded behind a button.
document.querySelectorAll('[data-autosubmit] select').forEach((s) => s.addEventListener('change', () => s.form.submit()))
const facets = document.querySelector('[data-facets]')
if (facets && matchMedia('(max-width: 860px)').matches) facets.open = false
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
