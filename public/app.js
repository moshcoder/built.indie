// built.indie: vote without a page load, copy buttons, progress while we read a site, the service worker.
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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
