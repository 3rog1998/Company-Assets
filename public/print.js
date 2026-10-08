// بيانات الترويسة الثابتة — عدّلها حسب بيانات الشركة
const COMPANY = {
  name: 'مصنع مروى للمياه الصحية',
  cr: '', // السجل التجاري
  vat: '', // الرقم الضريبي
};

const Print = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = `<style>
    .pf { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #000; font-size: 13px; direction: rtl; }
    .pf .hd { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #0b6e99; padding-bottom: 10px; margin-bottom: 12px; }
    .pf .hd img { height: 64px; } .pf .hd .t { flex: 1; } .pf .hd h1 { margin: 0; font-size: 18px; }
    .pf .hd small { color: #444; display: block; }
    .pf h2 { text-align: center; font-size: 17px; margin: 8px 0 12px; border: 1px solid #000; padding: 6px; }
    .pf table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    .pf th, .pf td { border: 1px solid #000; padding: 5px 7px; text-align: right; }
    .pf th { background: #eee; }
    .pf .meta td { border: none; padding: 2px 4px; }
    .pf .decl { margin: 10px 0; line-height: 1.9; }
    .pf .sig { display: flex; gap: 20px; margin-top: 26px; }
    .pf .sig > div { flex: 1; border: 1px solid #000; padding: 8px; min-height: 100px; }
    .pf .sig img { max-height: 60px; display: block; margin-top: 4px; }
    .pf .ft { margin-top: 18px; border-top: 1px solid #888; padding-top: 6px; font-size: 11px; color: #444; text-align: center; }
  </style>`;

  function html(move, settings) {
    const handover = move.type === 'handover';
    const partial = !handover && move.items.some((i) => !i.returned);
    const title = handover ? 'نموذج تسليم عهدة' : partial ? 'نموذج إرجاع عهدة جزئي' : 'نموذج إرجاع عهدة / إخلاء طرف';
    const e = move.employee;
    const given = move.items.filter((i) => i.returned);
    const kept = move.items.filter((i) => !i.returned);
    const rows = (list, withReason) => list.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.ref)}</td><td>${esc(i.name)}</td>
      <td>${esc(i.brand)}</td><td>${esc(i.serial || '—')}</td>${withReason ? `<td>${esc(i.reason || '—')}</td>` : ''}</tr>`).join('');
    const head = (reason) => `<tr><th>#</th><th>الرقم المرجعي</th><th>البيان</th><th>الماركة/الموديل</th><th>الرقم التسلسلي</th>${reason ? '<th>سبب عدم الإرجاع</th>' : ''}</tr>`;
    const date = new Date(move.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ar-SA-u-ca-gregory-nu-latn');
    const declaration = handover
      ? 'أقر أنا الموظف الموضح بياناته أعلاه بأنني استلمت العهدة المبينة في الجدول وهي بحالة جيدة، وأتعهد بالمحافظة عليها واستخدامها لأغراض العمل فقط، وبإعادتها عند طلبها أو عند انتهاء علاقتي بالشركة، وأتحمل مسؤولية فقدانها أو تلفها نتيجة الإهمال.'
      : partial
        ? 'أقر أنا الموظف بأنني سلمت العهدة المبينة في الجدول الأول، وأن العهدة الواردة في الجدول الثاني ما زالت في ذمتي للأسباب المذكورة.'
        : 'أقر أنا الموظف بأنني سلمت جميع العهد المبينة في الجدول، وأخلي طرفي منها.';
    const officerSig = move.officer?.has_signature ? `<img src="/api/signatures/${move.officer.id}" alt="">` : '';
    return `${css}<div class="pf">
      <div class="hd">${settings.has_logo ? '<img src="/api/logo" alt="">' : ''}
        <div class="t"><h1>${esc(COMPANY.name)}</h1>
        <small>${COMPANY.cr ? 'السجل التجاري: ' + esc(COMPANY.cr) : ''} ${COMPANY.vat ? ' — الرقم الضريبي: ' + esc(COMPANY.vat) : ''}</small></div>
        <div><b>${esc(move.ref)}</b><small>${date}</small></div></div>
      <h2>${title}</h2>
      <table class="meta"><tr><td><b>الموظف:</b> ${esc(e.name)}</td><td><b>الرقم الوظيفي:</b> ${esc(e.emp_no || '—')}</td></tr>
        <tr><td><b>المسمى:</b> ${esc(e.job_title || '—')}</td><td><b>القسم:</b> ${esc(e.department || '—')}</td></tr>
        ${move.notes ? `<tr><td colspan="2"><b>ملاحظات:</b> ${esc(move.notes)}</td></tr>` : ''}</table>
      ${partial ? '<b>العهد المُرجَعة</b>' : ''}
      <table>${head(false)}${rows(given, false)}</table>
      ${partial ? `<b>العهد غير المُرجَعة</b><table>${head(true)}${rows(kept, true)}</table>` : ''}
      <div class="decl">${declaration}</div>
      <div class="sig">
        <div><b>الموظف</b><br>الاسم: ${esc(e.name)}<br>التوقيع:<br>التاريخ:</div>
        <div><b>مسؤول العهدة</b><br>الاسم: ${esc(move.officer?.name || '')}<br>التوقيع:${officerSig}</div>
      </div>
      <div class="ft">${esc(settings.company_address || '')} ${settings.company_phone ? ' — هاتف: ' + esc(settings.company_phone) : ''}</div>
    </div>`;
  }
  return { html };
})();
