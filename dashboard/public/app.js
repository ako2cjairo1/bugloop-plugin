(function () {
  'use strict';

  var HAPPY_PATH = ['TRIAGE', 'REPRO', 'LOCATE', 'HYPOTHESIZE', 'PATCH', 'VERIFY', 'REVIEW', 'LANDED'];
  var EXIT_STATES = ['NOT_A_BUG', 'UNREPRODUCED', 'FLAKY', 'ARCHITECTURE_QUESTION', 'BLOCKED_NEEDS_HUMAN'];

  var mainEl = document.getElementById('main');
  var bugsCache = []; // last fetched /api/bugs list

  // ---------- data ----------

  function fetchBugs() {
    return fetch('/api/bugs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        bugsCache = data.bugs || [];
        document.getElementById('root-path').textContent = data.root || '';
        updateNavCounts();
        return bugsCache;
      });
  }

  function fetchDetail(id) {
    return fetch('/api/bugs/' + id).then(function (r) {
      if (!r.ok) throw new Error('not found');
      return r.json();
    });
  }

  function updateNavCounts() {
    document.getElementById('count-all').textContent = String(bugsCache.length);
    var pending = bugsCache.filter(function (b) { return b.pendingQuestion; });
    var countEl = document.getElementById('count-pending');
    countEl.textContent = String(pending.length);
    countEl.classList.toggle('has-pending', pending.length > 0);
  }

  // ---------- helpers ----------

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function stateChipClass(state) {
    if (state === 'LANDED') return 'state-landed';
    if (EXIT_STATES.indexOf(state) !== -1) {
      if (state === 'NOT_A_BUG') return 'state-notabug';
      if (state === 'ARCHITECTURE_QUESTION') return 'state-architecture';
      if (state === 'UNREPRODUCED') return 'state-unreproduced';
      if (state === 'FLAKY') return 'state-flaky';
      return 'state-blocked';
    }
    return 'state-active';
  }

  function relTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return iso;
    var diffMs = Date.now() - t;
    var mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.round(hrs / 24);
    return days + 'd ago';
  }

  // ---------- routing ----------

  function currentRoute() {
    return location.hash || '#/';
  }

  function navigate() {
    var hash = currentRoute();
    setActiveNav(hash);
    if (hash.indexOf('#/bug/') === 0) {
      renderDetail(decodeURIComponent(hash.slice('#/bug/'.length)));
    } else if (hash === '#/pending') {
      renderList(true);
    } else {
      renderList(false);
    }
  }

  function setActiveNav(hash) {
    document.getElementById('nav-all').classList.toggle('active', hash === '#/');
    document.getElementById('nav-pending').classList.toggle('active', hash === '#/pending');
  }

  window.addEventListener('hashchange', navigate);

  // Sidebar items are plain divs (not <a>), so clicks need a handler --
  // static markup, wired once here rather than on every render.
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-route]'), function (el) {
    el.addEventListener('click', function () {
      location.hash = el.getAttribute('data-route');
    });
  });

  // ---------- list view ----------

  function renderList(pendingOnly) {
    mainEl.innerHTML = '<div class="loading">Loading…</div>';
    fetchBugs().then(function (bugs) {
      var rows = pendingOnly ? bugs.filter(function (b) { return b.pendingQuestion; }) : bugs;
      var title = pendingOnly ? 'Pending Decisions' : 'All Bugs';
      var sub = pendingOnly
        ? 'Every ledger with an unanswered question, across all projects.'
        : 'Every BugLoop ledger, across all projects.';

      if (rows.length === 0) {
        mainEl.innerHTML =
          '<div class="page-head"><div><h1>' + esc(title) + '</h1><div class="page-sub">' + esc(sub) + '</div></div></div>' +
          '<div class="table-wrap"><div class="empty-state">' +
          (pendingOnly ? 'Nothing waiting on you.' : 'No bugs yet. Run <code>/bug "&lt;description&gt;"</code> in a project to start one.') +
          '</div></div>';
        return;
      }

      var body = rows.map(function (b) {
        var needsYou = b.pendingQuestion
          ? '<span class="needs-you">' + (b.pendingAnswer ? 'answered' : 'needs you') + '</span>'
          : '';
        return (
          '<tr class="row-link" data-id="' + esc(b.id) + '">' +
          '<td class="bug-title">' + esc(b.title) + '</td>' +
          '<td class="bug-project">' + esc(b.project) + (b.isActive ? ' <span title="active ledger for this project">●</span>' : '') + '</td>' +
          '<td><span class="chip ' + stateChipClass(b.state) + '">' + esc(b.state) + '</span></td>' +
          '<td>' + needsYou + '</td>' +
          '<td class="mono" style="color:var(--muted)">' + esc(relTime(b.createdAt)) + '</td>' +
          '</tr>'
        );
      }).join('');

      mainEl.innerHTML =
        '<div class="page-head"><div><h1>' + esc(title) + '</h1><div class="page-sub">' + esc(sub) + '</div></div></div>' +
        '<div class="table-wrap"><table class="bugs"><thead><tr>' +
        '<th>Bug</th><th>Project</th><th>State</th><th></th><th>Created</th>' +
        '</tr></thead><tbody>' + body + '</tbody></table></div>';

      Array.prototype.forEach.call(mainEl.querySelectorAll('tr.row-link'), function (tr) {
        tr.addEventListener('click', function () {
          location.hash = '#/bug/' + encodeURIComponent(tr.getAttribute('data-id'));
        });
      });
    }).catch(function (err) {
      mainEl.innerHTML = '<div class="error-box">Could not load bugs: ' + esc(err.message) + '</div>';
    });
  }

  // ---------- detail view ----------

  function renderStepper(state) {
    if (EXIT_STATES.indexOf(state) !== -1) {
      return '<div class="exit-badge">exited via ' + esc(state) + '</div>';
    }
    var idx = HAPPY_PATH.indexOf(state);
    var html = '<div class="stepper">';
    HAPPY_PATH.forEach(function (s, i) {
      var cls = i < idx ? 'done' : (i === idx ? 'current' : '');
      html += '<div class="step ' + cls + '"><span class="dot">' + (i < idx ? '✓' : i + 1) + '</span><span class="label">' + s + '</span></div>';
      if (i < HAPPY_PATH.length - 1) html += '<div class="step-connector"></div>';
    });
    html += '</div>';
    return html;
  }

  function kv(label, value, opts) {
    opts = opts || {};
    var empty = !value;
    var display = empty ? (opts.emptyText || '(empty)') : (opts.raw ? value : esc(value));
    return '<div class="kv-row"><span class="k">' + esc(label) + '</span><span class="v' + (empty ? ' empty' : '') + '">' + display + '</span></div>';
  }

  function renderPendingBanner(bug) {
    var f = bug.fields;
    var q = f['pending.question'];
    var answer = f['pending.answer'];
    if (!q) return '';
    var body = '<div class="pending-banner"><h3>Needs your decision</h3><p class="q">' + esc(q) + '</p>';
    if (answer) {
      body += '<p class="answered">Answered: <strong>' + esc(answer) + '</strong> — waiting for the terminal session to act on it and clear this.</p>';
    } else {
      body +=
        '<form class="answer-form" id="answer-form" data-mtime="' + esc(bug.mtimeMs) + '">' +
        '<textarea name="answer" placeholder="Type your answer…" required></textarea>' +
        '<button type="submit" class="btn primary">Send answer</button>' +
        '</form><div class="page-sub" style="margin-top:6px;">Sent as a single line — line breaks become spaces.</div>' +
        '<div id="answer-status"></div>';
    }
    body += '</div>';
    return body;
  }

  function renderHypotheses(hyps) {
    if (!hyps || hyps.length === 0) return '<div class="panel-body"><span class="v empty">none yet</span></div>';
    var items = hyps.slice().sort(function (a, b) { return a.n - b.n; }).map(function (h) {
      return (
        '<div class="hyp-item ' + esc(h.status) + '">' +
        '<div class="hyp-head"><span class="n">[' + h.n + ']</span><span class="status">' + esc(h.status.toUpperCase()) + '</span></div>' +
        '<div class="statement">' + esc(h.statement) + '</div>' +
        '<div class="evidence"><strong>Evidence:</strong> ' + esc(h.evidence) + '</div>' +
        '<div class="falsifier"><strong>Falsifier:</strong> ' + esc(h.falsifier) + '</div>' +
        '</div>'
      );
    }).join('');
    return '<div class="panel-body"><div class="hyp-list">' + items + '</div></div>';
  }

  function renderReceipts(receipts) {
    if (!receipts || receipts.length === 0) return '<div class="panel-body"><span class="v empty">none yet</span></div>';
    var items = receipts.slice().reverse().map(function (r) {
      var exitCls = r.exitCode === 0 ? 'exit-ok' : 'exit-fail';
      return (
        '<details class="receipt"><summary>' +
        '<span>' + esc(r.timestamp) + '</span>' +
        '<span class="' + exitCls + '">exit ' + r.exitCode + '</span>' +
        '<span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(r.cmd) + '</span>' +
        '</summary><pre>' + esc(r.output) + '</pre></details>'
      );
    }).join('');
    return '<div class="panel-body"><div class="receipt-list">' + items + '</div></div>';
  }

  function renderDetail(id) {
    mainEl.innerHTML = '<div class="loading">Loading…</div>';
    fetchDetail(id).then(function (bug) {
      var f = bug.fields;
      var html =
        '<a class="back-link" href="#/">← All Bugs</a>' +
        '<div class="detail-head"><div>' +
        '<h1 style="font-size:20px;margin:0;">' + esc(bug.title) + '</h1>' +
        '<div class="detail-meta">' +
        '<span>' + esc(bug.project) + (bug.isActive ? ' <span title="active">●</span>' : '') + '</span>' +
        '<span class="mono">' + esc(f.test_cmd || '') + '</span>' +
        '<span class="mono">engine ' + esc(f.engine_version || 'unknown') + '</span>' +
        '</div></div>' +
        '<span class="chip ' + stateChipClass(f.state) + '">' + esc(f.state) + '</span>' +
        '</div>' +
        renderStepper(f.state) +
        renderPendingBanner(bug) +
        '<div class="panel"><h3>Repro</h3><div class="panel-body">' +
        kv('test_cmd', f['repro.test_cmd']) +
        kv('failing_output', f['repro.failing_output']) +
        kv('not_a_bug_evidence', f['repro.not_a_bug_evidence']) +
        '</div></div>' +
        '<div class="panel"><h3>Locate</h3><div class="panel-body">' +
        kv('sites', f['locate.sites']) +
        '</div></div>' +
        '<div class="panel"><h3>Hypotheses</h3>' + renderHypotheses(bug.hypotheses) + '</div>' +
        '<div class="panel"><h3>Patch / Verify / Review</h3><div class="panel-body">' +
        kv('files_changed', f['patch.files_changed']) +
        kv('verify.focused', f['verify.focused']) +
        kv('verify.baseline_diff', f['verify.baseline_diff']) +
        kv('review.verdict', f['review.verdict']) +
        kv('review.rejection_count', f['review.rejection_count']) +
        kv('landed.committed', f['landed.committed']) +
        kv('landed.commit_sha', f['landed.commit_sha']) +
        '</div></div>' +
        '<div class="panel"><h3>Receipts</h3>' + renderReceipts(bug.receipts) + '</div>';

      mainEl.innerHTML = html;
      wireAnswerForm(id);
    }).catch(function (err) {
      mainEl.innerHTML = '<a class="back-link" href="#/">← All Bugs</a><div class="error-box">Could not load this bug: ' + esc(err.message) + '</div>';
    });
  }

  function wireAnswerForm(id) {
    var form = document.getElementById('answer-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var textarea = form.querySelector('textarea[name="answer"]');
      var statusEl = document.getElementById('answer-status');
      var btn = form.querySelector('button');
      // The engine stores this as one ledger line -- bugloop.sh rejects an
      // embedded newline outright. Collapse whatever the textarea's
      // multi-line typing produced into a single line rather than letting
      // the write fail with a confusing error.
      var answer = textarea.value.replace(/\s*\n+\s*/g, ' ').trim();
      if (!answer) return;
      btn.disabled = true;
      statusEl.innerHTML = '';
      fetch('/api/bugs/' + id + '/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answer, expectedMtimeMs: Number(form.getAttribute('data-mtime')) }),
      })
        .then(function (r) {
          return r.json().then(function (data) { return { ok: r.ok, data: data }; });
        })
        .then(function (res) {
          btn.disabled = false;
          if (!res.ok) {
            statusEl.innerHTML = '<div class="form-error">' + esc(res.data.error || 'Could not save.') + '</div>';
            return;
          }
          statusEl.innerHTML = '<div class="form-ok">Sent. The terminal session will act on it next.</div>';
          renderDetail(id);
        })
        .catch(function (err) {
          btn.disabled = false;
          statusEl.innerHTML = '<div class="form-error">' + esc(err.message) + '</div>';
        });
    });
  }

  // ---------- live updates ----------

  function connectEvents() {
    var es = new EventSource('/api/events');
    es.addEventListener('ledger-changed', function () {
      // Cheap and correct: re-run whatever's on screen right now against
      // fresh data, rather than trying to patch state in place.
      navigate();
    });
    es.onerror = function () {
      // EventSource auto-reconnects; nothing to do here beyond letting it.
    };
  }

  // ---------- boot ----------

  navigate();
  connectEvents();
})();
