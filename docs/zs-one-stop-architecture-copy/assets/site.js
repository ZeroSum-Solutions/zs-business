// Drawer navigation and on-page contents highlight. No dependencies; works from file://.
(function () {
  var body = document.body;
  var btn = document.querySelector('.menu-btn');
  var nav = document.getElementById('sidenav');
  var backdrop = document.querySelector('.nav-backdrop');
  var closeBtn = document.querySelector('.drawer-close');

  function setOpen(open) {
    body.classList.toggle('nav-open', open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && nav) {
      var first = nav.querySelector('[aria-current="page"]') || nav.querySelector('a');
      if (first) first.focus({ preventScroll: true });
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
    } else if (btn && document.activeElement && nav && nav.contains(document.activeElement)) {
      btn.focus();
    }
  }
  if (btn && nav) {
    btn.addEventListener('click', function () { setOpen(!body.classList.contains('nav-open')); });
    if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && body.classList.contains('nav-open')) setOpen(false);
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
  }

  // Close the inline contents after a jump on small screens.
  document.querySelectorAll('.toc-inline a').forEach(function (a) {
    a.addEventListener('click', function () {
      var d = a.closest('details');
      if (d) d.open = false;
    });
  });

  // Highlight the current heading in the right-hand contents.
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var byId = {};
  links.forEach(function (a) { byId[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
  var heads = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  var visible = new Set();
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) visible.add(en.target); else visible.delete(en.target);
    });
    var current = null;
    for (var i = 0; i < heads.length; i++) {
      if (visible.has(heads[i])) { current = heads[i]; break; }
    }
    if (!current) {
      for (var j = heads.length - 1; j >= 0; j--) {
        if (heads[j].getBoundingClientRect().top < 120) { current = heads[j]; break; }
      }
    }
    links.forEach(function (a) { a.classList.remove('active'); a.removeAttribute('aria-current'); });
    if (current && byId[current.id]) {
      byId[current.id].classList.add('active');
      byId[current.id].setAttribute('aria-current', 'location');
    }
  }, { rootMargin: '-72px 0px -60% 0px' });
  heads.forEach(function (h) { io.observe(h); });
})();

// Print button on the presentation pages.
document.querySelectorAll('.print-btn').forEach(function (b) {
  b.addEventListener('click', function () { window.print(); });
});
