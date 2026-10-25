// Hero demo: ticks a fake send queue. Static (all sent) when reduced motion is on.
(() => {
  const list = document.getElementById('queue');
  if (!list) return;
  const names = ['Spring cohort · Mon 11 AM', 'Spring cohort · Wed 11 AM', 'Weekend batch · Sat', 'Weekend batch · Sun', 'Alumni lounge', 'Beginners circle', 'Office hours'];
  const meter = document.getElementById('meter');
  list.innerHTML = names.map(n => `<li data-s="queued"><span>${n}</span><span class="st">queued</span></li>`).join('');
  const rows = [...list.children];
  const set = (i, s) => { rows[i].dataset.s = s; rows[i].lastChild.textContent = s === 'sent' ? 'sent ✓✓' : s; };
  const count = () => meter.textContent = `${rows.filter(r => r.dataset.s === 'sent').length} of ${rows.length} sent`;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { rows.forEach((_, i) => set(i, 'sent')); return count(); }
  const run = () => {
    rows.forEach((_, i) => set(i, 'queued')); count();
    let i = 0;
    const next = () => {
      if (i === rows.length) return setTimeout(run, 2600);
      const k = i++;
      set(k, 'sending');
      setTimeout(() => { set(k, 'sent'); count(); setTimeout(next, 350); }, 800);
    };
    setTimeout(next, 700);
  };
  run();
})();
