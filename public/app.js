const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { available: 'متاحة في المستودع', reserved: 'بانتظار توقيع التسليم', issued: 'مسلّمة', returning: 'بانتظار توقيع الإرجاع', retired: 'خارج الخدمة' };
const MOVE_STATUS = { pending: 'بانتظار التوقيع', signed: 'موقّع', cancelled: 'ملغى' };
const TYPE = { handover: 'تسليم', return: 'إرجاع' };
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('ar-SA-u-ca-gregory-nu-latn') : '—');

let me = null;
let settings = {};
const canEdit = () => me?.role === 'admin';

async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, headers: {} };
  if (form) opt.body = form;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opt);
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && me) { me = null; render(); }
  if (!res.ok) { const e = new Error(data.error || 'حدث خطأ'); e.errors = data.errors; throw e; }
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
const fail = (e) => alert([e.message, ...(e.errors || [])].join('\n'));

function modal(title, bodyHtml, onSubmit, { submit = 'حفظ' } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<form class="modal"><h2>${esc(title)}</h2>${bodyHtml}<p class="err" data-err></p>
    <div class="acts">${onSubmit ? `<button>${submit}</button>` : ''}<button type="button" class="sec" data-close>إغلاق</button></div></form>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('[data-close]').onclick = close;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    try { await onSubmit(Object.fromEntries(new FormData(e.target)), close, e.target); }
    catch (err) { ov.querySelector('[data-err]').textContent = [err.message, ...(err.errors || [])].join(' | '); }
  };
  return ov;
}
const field = (name, label, val = '', type = 'text', extra = '') => `<label>${label}</label><input name="${name}" type="${type}" value="${esc(val)}" ${extra}>`;
const tag = (cls, text) => `<span class="tag ${cls}">${esc(text)}</span>`;
const dis = () => (canEdit() ? '' : 'disabled');

// ---------- الهيكل ----------
function render() {
  if (!me) return renderLogin();
  const route = location.hash.slice(2) || 'dashboard';
  const nav = [['dashboard', 'الرئيسية'], ['assets', 'العهد'], ['moves', 'الاستلام والتسليم'], ['employees', 'الموظفون'], ['settings', 'الإعدادات']];
  if (canEdit()) nav.splice(4, 0, ['users', 'المستخدمون']);
  $('#app').innerHTML = `<header class="top"><span class="brand">إدارة العهد — مصنع مروى</span>
    <nav>${nav.map(([k, t]) => `<a href="#/${k}" class="${route.split('/')[0] === k ? 'on' : ''}">${t}</a>`).join('')}</nav>
    <span class="who">${esc(me.name)}${canEdit() ? '' : ' (اطّلاع فقط)'}</span><button class="sec sm" id="logout">خروج</button></header>
    <main id="main"></main>`;
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; render(); };
  const [page, a, b] = route.split('/');
  const pages = { dashboard: pageDashboard, assets: pageAssets, moves: () => (a === 'new' ? pageMoveForm(b) : a && b === 'edit' ? pageMoveForm(null, a) : a ? pageMove(a) : pageMoves()),
    employees: () => (a ? pageEmployee(a) : pageEmployees()), users: pageUsers, settings: pageSettings };
  (pages[page] || pageDashboard)().catch(fail);
}

function renderLogin() {
  $('#app').innerHTML = `<form class="card login"><h1>تسجيل الدخول</h1>${field('login', 'اسم المستخدم', '', 'text', 'autocomplete="username" required')}
    ${field('password', 'كلمة المرور', '', 'password', 'autocomplete="current-password" required')}<p class="err" id="lerr"></p><button>دخول</button></form>`;
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      await boot();
    } catch (err) { $('#lerr').textContent = err.message; }
  };
}

// ---------- الرئيسية ----------
async function pageDashboard() {
  const s = await api('/stats');
  const st = (n, t) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`;
  $('#main').innerHTML = `<h1>الرئيسية</h1><div class="grid">
    ${st(s.assets.available, 'متاحة في المستودع')}${st(s.assets.issued, 'مسلّمة للموظفين')}
    ${st(s.assets.reserved + s.assets.returning, 'قيد التوقيع')}${st(s.assets.retired, 'خارج الخدمة')}
    ${st(s.employees_with_custody, 'موظفون لديهم عهد')}
    ${st(s.pending.handover, 'تسليم بانتظار التوقيع')}${st(s.pending.return, 'إرجاع بانتظار التوقيع')}</div>
    ${canEdit() ? `<div class="bar" style="margin-top:14px"><a class="btn" href="#/moves/new/handover">+ نموذج تسليم</a><a class="btn sec" href="#/moves/new/return">+ نموذج إرجاع</a></div>` : ''}`;
}

// ---------- العهد ----------
async function pageAssets() {
  $('#main').innerHTML = `<h1>إدارة العهد</h1><div class="bar">
    <input id="q" placeholder="بحث: اسم / رقم / تسلسلي / موظف"><select id="st"><option value="">كل الحالات</option>
    ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><span class="sp"></span>
    ${canEdit() ? '<button id="add">+ إضافة</button><button class="sec" id="imp">استيراد Excel</button>' : ''}
    <a class="btn sec" href="/api/assets/export">تصدير Excel</a></div><div class="tablewrap" id="list"></div>`;
  const load = async () => {
    const rows = await api(`/assets?q=${encodeURIComponent($('#q').value)}&status=${$('#st').value}`);
    $('#list').innerHTML = `<table><tr><th>الرقم</th><th>الاسم</th><th>التصنيف</th><th>التسلسلي</th><th>الحالة</th><th>الموظف</th></tr>
      ${rows.map((a) => `<tr class="row" data-id="${a.id}"><td>${esc(a.ref)}</td><td>${esc(a.name)}<div class="muted">${esc(a.brand)}</div></td><td>${esc(a.category)}</td>
      <td>${esc(a.serial || '—')}</td><td>${tag(a.status, STATUS[a.status])}</td><td>${esc(a.holder_name || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لا توجد نتائج</td></tr>'}</table>`;
    document.querySelectorAll('tr.row').forEach((r) => { r.onclick = () => assetDialog(r.dataset.id, load).catch(fail); });
  };
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); };
  $('#st').onchange = () => load().catch(fail);
  if (canEdit()) {
    $('#add').onclick = () => modal('إضافة عهدة', `${field('name', 'الاسم', '', 'text', 'required')}<div class="cols"><div>${field('category', 'التصنيف')}</div><div>${field('brand', 'الماركة/الموديل')}</div></div>
      <label>الأرقام التسلسلية (رقم في كل سطر — وحدة لكل رقم، ويمكن استخدام قارئ الباركود)</label><textarea name="serials"></textarea>
      ${field('quantity', 'أو العدد (إن لم تُدخل أرقاماً)', '1', 'number', 'min="1" max="500"')}<label>ملاحظات</label><textarea name="notes"></textarea>`,
      async (d, close) => {
        await api('/assets', { method: 'POST', body: { ...d, serials: d.serials.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) } });
        close(); toast('تمت الإضافة'); load();
      });
    $('#imp').onclick = () => importDialog('/assets/import', load);
  }
  await load();
}

function importDialog(url, done) {
  modal('استيراد من Excel', '<label>اختر ملف .xlsx (صدّر الملف الحالي لاستخدامه كقالب)</label><input type="file" name="file" accept=".xlsx" required>',
    async (_d, close, f) => {
      const r = await api(url, { method: 'POST', form: new FormData(f) });
      close(); toast(`تم: إضافة ${r.added} / تعديل ${r.updated}`); done();
    }, { submit: 'رفع' });
}

async function assetDialog(id, reload) {
  const a = await api('/assets/' + id);
  const ov = modal(`${a.ref} — ${a.name}`, `<p>${tag(a.status, a.status_ar)} ${a.holder_name ? '— ' + esc(a.holder_name) : ''}</p>
    ${field('name', 'الاسم', a.name, 'text', `required ${dis()}`)}<div class="cols"><div>${field('category', 'التصنيف', a.category, 'text', dis())}</div><div>${field('brand', 'الماركة/الموديل', a.brand, 'text', dis())}</div></div>
    ${field('serial', 'الرقم التسلسلي', a.serial || '', 'text', dis())}<label>ملاحظات</label><textarea name="notes" ${dis()}>${esc(a.notes)}</textarea>
    <h2 style="margin-top:14px">السجل</h2>${a.history.map((h) => `<div><a href="#/moves/${h.id}" data-close-link>${esc(h.ref)}</a> — ${TYPE[h.type]} — ${esc(h.employee_name)} — ${MOVE_STATUS[h.status]} — ${fmtDate(h.created_at)}</div>`).join('') || '<span class="muted">لا يوجد سجل</span>'}
    ${canEdit() ? `<div class="bar" style="margin-top:12px">${a.status === 'available' ? '<button type="button" class="sec sm" data-act="retire">إخراج من الخدمة</button>' : ''}
      ${a.status === 'retired' ? '<button type="button" class="sec sm" data-act="restore">إعادة للخدمة</button>' : ''}
      ${a.history.length ? '' : '<button type="button" class="danger sm" data-act="delete">حذف</button>'}</div>` : ''}`,
    canEdit() ? async (d, close) => { await api('/assets/' + id, { method: 'PUT', body: d }); close(); toast('تم الحفظ'); reload(); } : null);
  ov.querySelectorAll('[data-close-link]').forEach((l) => { l.onclick = () => ov.remove(); });
  ov.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'delete' && !confirm('حذف العهدة نهائياً؟')) return;
      try {
        if (act === 'delete') await api('/assets/' + id, { method: 'DELETE' });
        else await api(`/assets/${id}/${act}`, { method: 'POST', body: {} });
        ov.remove(); reload();
      } catch (e) { fail(e); }
    };
  });
}

// ---------- النماذج ----------
async function pageMoves() {
  $('#main').innerHTML = `<h1>الاستلام والتسليم</h1><div class="bar"><select id="ty"><option value="">الكل</option><option value="handover">تسليم</option><option value="return">إرجاع</option></select>
    <select id="st"><option value="">كل الحالات</option>${Object.entries(MOVE_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <input id="q" placeholder="بحث: رقم النموذج / الموظف"><span class="sp"></span>
    ${canEdit() ? '<a class="btn" href="#/moves/new/handover">+ تسليم</a><a class="btn sec" href="#/moves/new/return">+ إرجاع</a>' : ''}</div><div class="tablewrap" id="list"></div>`;
  const load = async () => {
    const rows = await api(`/moves?type=${$('#ty').value}&status=${$('#st').value}&q=${encodeURIComponent($('#q').value)}`);
    $('#list').innerHTML = `<table><tr><th>الرقم</th><th>النوع</th><th>الموظف</th><th>العهد</th><th>الحالة</th><th>التاريخ</th></tr>
      ${rows.map((m) => `<tr class="row" onclick="location.hash='#/moves/${m.id}'"><td>${esc(m.ref)}</td><td>${TYPE[m.type]}${m.kept_count ? ' (جزئي)' : ''}</td><td>${esc(m.employee_name)}</td>
      <td>${m.items_count}</td><td>${tag(m.status, MOVE_STATUS[m.status])}</td><td>${fmtDate(m.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لا توجد نماذج</td></tr>'}</table>`;
  };
  ['#ty', '#st'].forEach((s) => { $(s).onchange = () => load().catch(fail); });
  $('#q').oninput = () => load().catch(fail);
  await load();
}

async function pageMoveForm(type, editId) {
  const existing = editId ? await api('/moves/' + editId) : null;
  type = existing ? existing.type : type;
  if (!canEdit() || !TYPE[type]) { location.hash = '#/moves'; return; }
  const employees = await api('/employees');
  $('#main').innerHTML = `<h1>${existing ? 'تعديل ' + esc(existing.ref) : type === 'handover' ? 'نموذج تسليم عهدة جديد' : 'نموذج إرجاع عهدة جديد'}</h1>
    <form class="card" id="f"><label>الموظف</label><select name="employee_id" required ${existing ? 'disabled' : ''}><option value="">— اختر —</option>
    ${employees.map((e) => `<option value="${e.id}" ${existing?.employee_id === e.id ? 'selected' : ''}>${esc(e.name)}${e.emp_no ? ' (' + esc(e.emp_no) + ')' : ''}</option>`).join('')}</select>
    <label>${type === 'handover' ? 'العهد المتاحة للتسليم' : 'العهد التي في ذمة الموظف (أزل التحديد عمّا لم يُرجَع واذكر السبب)'}</label>
    <input id="flt" placeholder="تصفية..." style="margin-bottom:6px"><div class="pick" id="pick"><div class="muted" style="padding:10px">اختر الموظف أولاً</div></div>
    <label>ملاحظات</label><textarea name="notes">${esc(existing?.notes || '')}</textarea><p class="err" id="ferr"></p>
    <button>${existing ? 'حفظ التعديل' : 'إنشاء النموذج'}</button> <a class="btn sec" href="#/moves${existing ? '/' + existing.id : ''}">إلغاء</a></form>`;

  let list = [];
  const prior = new Map((existing?.items || []).map((i) => [i.asset_id, i]));
  const paint = () => {
    const f = $('#flt').value.trim();
    $('#pick').innerHTML = list.filter((a) => !f || `${a.ref} ${a.name} ${a.serial} ${a.category}`.includes(f)).map((a) => `<label>
      <input type="checkbox" value="${a.id}" ${a.checked ? 'checked' : ''}> <span>${esc(a.ref)} — ${esc(a.name)} ${a.serial ? '(' + esc(a.serial) + ')' : ''}</span>
      ${type === 'return' ? `<input class="reason" data-r="${a.id}" placeholder="سبب عدم الإرجاع" value="${esc(a.reason || '')}" style="${a.checked ? 'display:none' : ''}">` : ''}</label>`).join('') || '<div class="muted" style="padding:10px">لا توجد عهد</div>';
    $('#pick').querySelectorAll('input[type=checkbox]').forEach((c) => {
      c.onchange = () => {
        const a = list.find((x) => x.id === Number(c.value)); a.checked = c.checked;
        const r = $(`[data-r="${a.id}"]`); if (r) r.style.display = c.checked ? 'none' : '';
      };
    });
    $('#pick').querySelectorAll('.reason').forEach((r) => { r.oninput = () => { list.find((x) => x.id === Number(r.dataset.r)).reason = r.value; }; });
  };
  const loadAssets = async (empId) => {
    if (type === 'handover') {
      const avail = await api('/assets?status=available');
      const mine = existing ? (await api(`/assets?holder=${empId}&status=reserved`)).filter((a) => prior.has(a.id)) : [];
      list = [...mine, ...avail].map((a) => ({ ...a, checked: prior.has(a.id) }));
    } else {
      list = (await api(`/assets?holder=${empId}`)).filter((a) => a.status === 'issued' || (a.status === 'returning' && prior.has(a.id)))
        .map((a) => ({ ...a, checked: existing ? prior.get(a.id)?.returned === 1 : true, reason: prior.get(a.id)?.reason || '' }));
    }
    paint();
  };
  $('#flt').oninput = paint;
  const sel = $('select[name=employee_id]');
  if (type === 'handover' && !existing) await loadAssets(0);
  sel.onchange = () => { if (sel.value) loadAssets(sel.value).catch(fail); };
  if (existing) await loadAssets(existing.employee_id);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const asset_ids = list.filter((a) => a.checked).map((a) => a.id);
    const excluded = list.filter((a) => !a.checked).map((a) => ({ asset_id: a.id, reason: a.reason || '' }));
    try {
      const body = { type, employee_id: Number(sel.value || existing?.employee_id), asset_ids, excluded, notes: e.target.notes.value };
      const r = existing ? await api('/moves/' + existing.id, { method: 'PUT', body }) : await api('/moves', { method: 'POST', body });
      location.hash = `#/moves/${existing ? existing.id : r.id}`;
    } catch (err) { $('#ferr').textContent = err.message; }
  };
}

async function pageMove(id) {
  const m = await api('/moves/' + id);
  const given = m.items.filter((i) => i.returned);
  const kept = m.items.filter((i) => !i.returned);
  const table = (rows, reason) => `<div class="tablewrap"><table><tr><th>الرقم</th><th>البيان</th><th>التسلسلي</th>${reason ? '<th>السبب</th>' : ''}</tr>
    ${rows.map((i) => `<tr><td>${esc(i.ref)}</td><td>${esc(i.name)}</td><td>${esc(i.serial || '—')}</td>${reason ? `<td>${esc(i.reason || '—')}</td>` : ''}</tr>`).join('')}</table></div>`;
  $('#main').innerHTML = `<h1>${esc(m.ref)} — ${TYPE[m.type]}${kept.length ? ' جزئي' : ''} ${tag(m.status, MOVE_STATUS[m.status])}</h1>
    <div class="card"><div>الموظف: <a href="#/employees/${m.employee_id}">${esc(m.employee_name)}</a></div><div>التاريخ: ${fmtDate(m.created_at)} — أنشأه: ${esc(m.created_by_name || '')}</div>
    ${m.signed_at ? `<div>تاريخ التوقيع: ${fmtDate(m.signed_at)}</div>` : ''}${m.notes ? `<div>ملاحظات: ${esc(m.notes)}</div>` : ''}</div>
    <h2>${kept.length ? 'العهد المُرجَعة' : 'العهد'}</h2>${table(given)}${kept.length ? `<h2 style="margin-top:12px">غير المُرجَعة</h2>${table(kept, true)}` : ''}
    <div class="bar" style="margin-top:14px"><button id="print">طباعة النموذج</button>
    ${m.signed_file ? `<a class="btn sec" target="_blank" href="/api/files/${esc(m.signed_file)}">عرض النموذج الموقّع</a>` : ''}
    ${canEdit() && m.status !== 'cancelled' ? `<button class="sec" id="sign">${m.signed_file ? 'استبدال المرفق' : 'إرفاق النموذج الموقّع'}</button>` : ''}
    ${canEdit() && m.status === 'pending' ? `<a class="btn sec" href="#/moves/${m.id}/edit">تعديل</a><button class="danger" id="cancel">إلغاء النموذج</button>` : ''}</div>`;
  $('#print').onclick = () => { $('#printArea').innerHTML = Print.html(m, settings); setTimeout(() => window.print(), 200); };
  $('#sign')?.addEventListener('click', () => modal('إرفاق النموذج الموقّع', '<label>صورة أو PDF</label><input type="file" name="file" accept="image/*,application/pdf" required>',
    async (_d, close, f) => { await api(`/moves/${m.id}/sign`, { method: 'POST', form: new FormData(f) }); close(); render(); }, { submit: 'رفع' }));
  $('#cancel')?.addEventListener('click', async () => {
    if (!confirm('إلغاء النموذج؟ ستعود العهد لوضعها السابق.')) return;
    await api('/moves/' + m.id, { method: 'DELETE' }); render();
  });
}

// ---------- الموظفون ----------
function employeeForm(e = {}) {
  return `${field('name', 'الاسم', e.name, 'text', 'required')}<div class="cols"><div>${field('emp_no', 'الرقم الوظيفي', e.emp_no || '')}</div><div>${field('phone', 'الجوال', e.phone)}</div>
    <div>${field('job_title', 'المسمى الوظيفي', e.job_title)}</div><div>${field('department', 'القسم', e.department)}</div></div>${field('notes', 'ملاحظات', e.notes)}`;
}
const contact = (p) => (p ? `<a href="tel:${esc(p)}">${esc(p)}</a> <a href="https://wa.me/${esc(p)}" target="_blank">واتساب</a>` : '');

async function pageEmployees() {
  $('#main').innerHTML = `<h1>الموظفون</h1><div class="bar"><input id="q" placeholder="بحث"><span class="sp"></span>
    ${canEdit() ? '<button id="add">+ موظف</button><button class="sec" id="imp">استيراد Excel</button>' : ''}<a class="btn sec" href="/api/employees/export">تصدير Excel</a></div><div class="tablewrap" id="list"></div>`;
  const load = async () => {
    const rows = await api('/employees?q=' + encodeURIComponent($('#q').value));
    $('#list').innerHTML = `<table><tr><th>الاسم</th><th>الرقم الوظيفي</th><th>القسم</th><th>الجوال</th><th>العهد</th></tr>
      ${rows.map((e) => `<tr class="row" data-id="${e.id}"><td>${esc(e.name)}<div class="muted">${esc(e.job_title)}</div></td><td>${esc(e.emp_no || '')}</td><td>${esc(e.department)}</td>
      <td onclick="event.stopPropagation()">${contact(e.phone)}</td><td>${e.assets_count}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">لا يوجد موظفون</td></tr>'}</table>`;
    document.querySelectorAll('tr.row').forEach((r) => { r.onclick = () => { location.hash = '#/employees/' + r.dataset.id; }; });
  };
  $('#q').oninput = () => load().catch(fail);
  if (canEdit()) {
    $('#add').onclick = () => modal('موظف جديد', employeeForm(), async (d, close) => { await api('/employees', { method: 'POST', body: d }); close(); load(); });
    $('#imp').onclick = () => importDialog('/employees/import', load);
  }
  await load();
}

async function pageEmployee(id) {
  const e = await api('/employees/' + id);
  $('#main').innerHTML = `<h1>${esc(e.name)}</h1><div class="card"><div>${esc(e.job_title)} ${e.department ? '— ' + esc(e.department) : ''} ${e.emp_no ? '— رقم وظيفي ' + esc(e.emp_no) : ''}</div>
    <div>${contact(e.phone)}</div>${e.notes ? `<div class="muted">${esc(e.notes)}</div>` : ''}
    ${canEdit() ? '<div class="bar" style="margin-top:10px"><button class="sec sm" id="edit">تعديل</button><button class="danger sm" id="del">حذف</button></div>' : ''}</div>
    <h2>العهد في ذمته</h2><div class="tablewrap"><table><tr><th>الرقم</th><th>البيان</th><th>التسلسلي</th><th>الحالة</th></tr>
    ${e.assets.map((a) => `<tr><td>${esc(a.ref)}</td><td>${esc(a.name)}</td><td>${esc(a.serial || '—')}</td><td>${tag(a.status, STATUS[a.status])}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا توجد عهد</td></tr>'}</table></div>
    <h2 style="margin-top:14px">سجل النماذج</h2><div class="tablewrap"><table><tr><th>الرقم</th><th>النوع</th><th>الحالة</th><th>التاريخ</th></tr>
    ${e.moves.map((m) => `<tr class="row" onclick="location.hash='#/moves/${m.id}'"><td>${esc(m.ref)}</td><td>${TYPE[m.type]}</td><td>${tag(m.status, MOVE_STATUS[m.status])}</td><td>${fmtDate(m.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا توجد نماذج</td></tr>'}</table></div>`;
  $('#edit')?.addEventListener('click', () => modal('تعديل الموظف', employeeForm(e), async (d, close) => { await api('/employees/' + id, { method: 'PUT', body: d }); close(); render(); }));
  $('#del')?.addEventListener('click', async () => {
    if (!confirm('حذف الموظف؟')) return;
    await api('/employees/' + id, { method: 'DELETE' }); location.hash = '#/employees';
  });
}

// ---------- المستخدمون والإعدادات ----------
async function pageUsers() {
  const users = await api('/users');
  $('#main').innerHTML = `<h1>المستخدمون</h1><div class="bar"><button id="add">+ مستخدم (اطّلاع فقط)</button></div><div class="tablewrap"><table>
    <tr><th>المستخدم</th><th>الاسم</th><th>الصلاحية</th><th>الحالة</th><th>آخر نشاط</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.login)}</td><td>${esc(u.name)}</td><td>${u.role === 'admin' ? 'مدير عام' : 'اطّلاع فقط'}</td>
    <td>${u.disabled ? tag('retired', 'موقوف') : tag('available', 'فعّال')}</td><td>${fmtDate(u.last_activity)}</td><td><button class="sec sm" data-id="${u.id}">تعديل</button></td></tr>`).join('')}</table></div>`;
  $('#add').onclick = () => modal('مستخدم جديد', `${field('login', 'اسم المستخدم', '', 'text', 'required')}${field('name', 'الاسم', '', 'text', 'required')}${field('password', 'كلمة المرور', '', 'password', 'required minlength="6"')}`,
    async (d, close) => { await api('/users', { method: 'POST', body: d }); close(); render(); });
  document.querySelectorAll('button[data-id]').forEach((b) => {
    const u = users.find((x) => x.id === Number(b.dataset.id));
    b.onclick = () => modal('تعديل ' + u.login, `${field('name', 'الاسم', u.name)}${field('password', 'كلمة مرور جديدة (اختياري)', '', 'password')}
      <label><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''} style="width:auto"> إيقاف الحساب</label>`,
      async (d, close, f) => { await api('/users/' + u.id, { method: 'PUT', body: { name: d.name, password: d.password, disabled: f.disabled.checked } }); close(); render(); });
  });
}

async function pageSettings() {
  settings = await api('/settings');
  $('#main').innerHTML = `<h1>الإعدادات</h1>
    ${canEdit() ? `<form class="card" id="co"><h2>بيانات الشركة (تذييل النماذج)</h2>${field('company_address', 'العنوان', settings.company_address)}${field('company_phone', 'الهاتف', settings.company_phone)}
      <p><button>حفظ</button></p><label>الشعار ${settings.has_logo ? '<img src="/api/logo" height="40">' : ''}</label><input type="file" id="logo" accept="image/*">
      ${settings.has_logo ? '<p><button type="button" class="sec sm" id="rmlogo">حذف الشعار</button></p>' : ''}</form>` : ''}
    <form class="card" id="prof"><h2>حسابي</h2>${field('name', 'الاسم الكامل', me.name, 'text', 'required')}<p><button>حفظ الاسم</button></p></form>
    ${canEdit() ? `<div class="card"><h2>توقيعي (صورة PNG شفافة تظهر في النماذج) ${me.has_signature ? tag('available', 'مرفوع') : ''}</h2>
      <input type="file" id="sig" accept="image/png"> ${me.has_signature ? '<button class="sec sm" id="rmsig">حذف</button>' : ''}</div>` : ''}
    <form class="card" id="pw"><h2>تغيير كلمة المرور</h2>${field('current', 'الحالية', '', 'password', 'required')}${field('next', 'الجديدة (6 أحرف على الأقل)', '', 'password', 'required minlength="6"')}<p><button>تغيير</button></p></form>`;
  const act = (sel, ev, fn) => $(sel)?.addEventListener(ev, async (e) => { e.preventDefault(); try { await fn(e); } catch (err) { fail(err); } });
  const refresh = async () => { me = (await api('/me')).user; render(); };
  act('#co', 'submit', async (e) => { await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('تم الحفظ'); });
  act('#logo', 'change', async (e) => { const f = new FormData(); f.append('file', e.target.files[0]); await api('/settings/logo', { method: 'POST', form: f }); render(); });
  act('#rmlogo', 'click', async () => { await api('/settings/logo', { method: 'DELETE' }); render(); });
  act('#prof', 'submit', async (e) => { await api('/me', { method: 'PUT', body: { name: e.target.name.value } }); await refresh(); toast('تم الحفظ'); });
  act('#sig', 'change', async (e) => { const f = new FormData(); f.append('file', e.target.files[0]); await api('/me/signature', { method: 'POST', form: f }); await refresh(); });
  act('#rmsig', 'click', async () => { await api('/me/signature', { method: 'DELETE' }); await refresh(); });
  act('#pw', 'submit', async (e) => { await api('/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('تم تغيير كلمة المرور'); });
}

// ---------- الإقلاع ----------
async function boot() {
  if (me) {
    me = (await api('/me')).user;
    if (me) settings = await api('/settings').catch(() => ({}));
  }
  render();
}
window.addEventListener('hashchange', () => { if (me) render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  try { me = (await api('/me')).user; if (me) settings = await api('/settings'); } catch { me = null; }
  render();
})();
