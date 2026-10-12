(() => {
  "use strict";

  const CONFIG_KEY = "kas-keluar-supabase-config";
  const classifications = {
    asset: "Aset",
    liability: "Liabilitas",
    equity: "Ekuitas",
    revenue: "Pendapatan",
    expense: "Beban"
  };
  const titles = {
    dashboard: ["Dashboard", "RINGKASAN KEUANGAN"],
    accounts: ["Master Akun", "DATA MASTER"],
    journals: ["Jurnal Umum", "BUKU BESAR"],
    "cash-out": ["Kas Keluar", "TRANSAKSI BARU"],
    reports: ["Laporan", "IKHTISAR"]
  };
  const state = { accounts: [], headers: [], lines: [], config: null };
  const $ = (selector) => document.querySelector(selector);
  let toastTimeout;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function money(value) {
    return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 }).format(Number(value) || 0);
  }

  function dateLabel(value) {
    if (!value) return "—";
    const parsed = new Date(`${value}T00:00:00`);
    return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
  }

  function getConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return window.KAS_KELUAR_SUPABASE_CONFIG || null;
      const config = JSON.parse(raw);
      if (!config.url || !config.key) return null;
      return config;
    } catch (error) {
      console.error("Konfigurasi Supabase tidak dapat dibaca.", error);
      showToast("Pengaturan Supabase tidak dapat dibaca. Silakan simpan ulang.", true);
      return null;
    }
  }

  async function supabaseRequest(path, options = {}) {
    if (!state.config) throw new Error("Koneksi Supabase belum diatur.");
    const response = await fetch(`${state.config.url}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: state.config.key,
        Authorization: `Bearer ${state.config.key}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `Supabase mengembalikan HTTP ${response.status}.`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 3600);
  }

  function showNotice(message, isError = false) {
    const notice = $("#app-notice");
    notice.textContent = message;
    notice.classList.toggle("error", isError);
    notice.classList.remove("hidden");
  }

  function clearNotice() {
    $("#app-notice").classList.add("hidden");
  }

  function explainJournalError(error) {
    let detail;
    try {
      detail = JSON.parse(error.message);
    } catch {
      detail = null;
    }
    if (detail?.code === "PGRST202" && detail.message?.includes("create_journal_entry")) {
      return "Fungsi jurnal debit/kredit belum ada di Supabase. Jalankan database/schema.sql di Supabase SQL Editor, lalu coba lagi.";
    }
    return `Transaksi gagal disimpan: ${error.message}`;
  }

  function emptyRow(columns, message) {
    return `<tr><td class="empty-cell" colspan="${columns}">${escapeHtml(message)}</td></tr>`;
  }

  function setConnected(connected) {
    $("#connection-label").textContent = connected
      ? "Supabase terhubung"
      : state.config ? "Koneksi tersimpan" : "Atur koneksi Supabase";
    $(".connection-dot").classList.toggle("connected", connected);
  }

  function renderAll() {
    renderDashboard();
    renderAccounts();
    renderJournals();
    renderJournalAccountOptions();
    renderReports();
    updateJournalBalance();
  }

  function postedHeaders() {
    return state.headers.filter((header) => header.status_posting === "posted");
  }

  function linesForHeader(headerId) {
    return state.lines.filter((line) => line.header_id === headerId);
  }

  function totalForHeader(headerId, side) {
    return linesForHeader(headerId).reduce((total, line) => total + Number(line[side] || 0), 0);
  }

  function renderDashboard() {
    $("#stat-accounts").textContent = state.accounts.length;
    $("#stat-journals").textContent = state.headers.length;
    const cashOutTotal = postedHeaders().reduce((total, header) => {
      return total + linesForHeader(header.id)
        .filter((line) => {
          const account = state.accounts.find((item) => item.id === line.account_id);
          return account?.report_classification === "expense";
        })
        .reduce((subtotal, line) => subtotal + Number(line.debit || 0), 0);
    }, 0);
    $("#stat-cash-out").textContent = money(cashOutTotal);
    const recent = [...state.headers].sort((a, b) => b.transaction_date.localeCompare(a.transaction_date)).slice(0, 5);
    $("#recent-journals").innerHTML = recent.length ? recent.map((header) => `
      <tr>
        <td>${escapeHtml(dateLabel(header.transaction_date))}</td>
        <td>${escapeHtml(header.reference_number)}</td>
        <td>${escapeHtml(header.description)}</td>
        <td><span class="status-badge ${header.status_posting === "draft" ? "draft" : ""}">${escapeHtml(header.status_posting)}</span></td>
        <td class="align-right">${escapeHtml(money(totalForHeader(header.id, "debit")))}</td>
      </tr>`).join("") : emptyRow(5, "Belum ada jurnal. Jurnal terbaru akan muncul di sini.");
  }

  function renderAccounts() {
    $("#account-count").textContent = `${state.accounts.length} akun`;
    const accounts = [...state.accounts].sort((a, b) => String(a.account_code).localeCompare(String(b.account_code), "id", { numeric: true }));
    $("#accounts-table").innerHTML = accounts.length ? accounts.map((account) => `
      <tr>
        <td><strong>${escapeHtml(account.account_code)}</strong></td>
        <td>${escapeHtml(account.account_name)}</td>
        <td>${escapeHtml(classifications[account.report_classification] || account.report_classification)}</td>
        <td>${escapeHtml(account.normal_balance === "debit" ? "Debit" : "Kredit")}</td>
        <td><div class="account-row-actions"><button class="button button-outline" type="button" data-edit-account="${escapeHtml(account.id)}">Ubah</button><button class="button button-outline" type="button" data-delete-account="${escapeHtml(account.id)}">Hapus</button></div></td>
      </tr>`).join("") : emptyRow(5, "Belum ada akun.");
  }

  function resetAccountForm() {
    const form = $("#account-form");
    form.reset();
    form.elements.id.value = "";
    $("#account-submit").innerHTML = 'Simpan akun <span>→</span>';
    $("#cancel-account-edit").classList.add("hidden");
    form.querySelector(".panel-title h3").textContent = "Tambah akun";
    form.querySelector(".panel-title p").textContent = "Lengkapi informasi akun baru.";
  }

  function editAccount(accountId) {
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      showToast("Akun tidak ditemukan. Muat ulang data dan coba lagi.", true);
      return;
    }
    const form = $("#account-form");
    form.elements.id.value = account.id;
    form.elements.account_code.value = account.account_code;
    form.elements.account_name.value = account.account_name;
    form.elements.normal_balance.value = account.normal_balance;
    form.elements.report_classification.value = account.report_classification;
    $("#account-submit").textContent = "Simpan perubahan";
    $("#cancel-account-edit").classList.remove("hidden");
    form.querySelector(".panel-title h3").textContent = "Ubah akun";
    form.querySelector(".panel-title p").textContent = `Mengubah akun ${account.account_code}.`;
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function deleteAccount(accountId) {
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      showToast("Akun tidak ditemukan. Muat ulang data dan coba lagi.", true);
      return;
    }
    if (!window.confirm(`Hapus akun ${account.account_code} — ${account.account_name}? Akun yang sudah dipakai jurnal tidak dapat dihapus.`)) return;
    try {
      const deleted = await supabaseRequest(`chart_of_accounts?id=eq.${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        headers: { Prefer: "return=representation" }
      });
      if (!deleted?.length) throw new Error("Akun tidak terhapus. Akun mungkin sudah dipakai di jurnal.");
      if ($("#account-form").elements.id.value === account.id) resetAccountForm();
      showToast("Akun berhasil dihapus.");
      await loadData();
    } catch (error) {
      showToast(`Akun gagal dihapus: ${error.message}`, true);
    }
  }

  function renderJournals() {
    const headers = [...state.headers].sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
    $("#journals-table").innerHTML = headers.length ? headers.map((header) => {
      const hasReversal = state.headers.some((item) => item.reverses_header_id === header.id);
      const action = header.status_posting !== "posted" ? "—" : hasReversal
        ? '<span class="reversal-note">Sudah dibalik</span>'
        : `<button class="button button-outline reversal-button" type="button" data-reverse-id="${escapeHtml(header.id)}" data-reference="${escapeHtml(header.reference_number)}">Buat storno</button>`;
      const description = header.reverses_header_id
        ? `${escapeHtml(header.description)}<small class="reversal-note">Pembalik dari ${escapeHtml(state.headers.find((item) => item.id === header.reverses_header_id)?.reference_number || "jurnal")}</small>`
        : escapeHtml(header.description);
      return `
      <tr>
        <td>${escapeHtml(dateLabel(header.transaction_date))}</td>
        <td>${escapeHtml(header.reference_number)}</td>
        <td>${description}</td>
        <td><span class="status-badge ${header.status_posting === "draft" ? "draft" : ""}">${escapeHtml(header.status_posting)}</span></td>
        <td class="align-right">${escapeHtml(money(totalForHeader(header.id, "debit")))}</td>
        <td class="align-right">${escapeHtml(money(totalForHeader(header.id, "credit")))}</td>
        <td>${action}</td>
      </tr>`;
    }).join("") : emptyRow(7, "Belum ada jurnal.");
  }

  function journalAccountOptions(selectedId = "") {
    const options = state.accounts.map((account) => {
      const selected = account.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(account.id)}"${selected}>${escapeHtml(account.account_code)} — ${escapeHtml(account.account_name)}</option>`;
    }).join("");
    return `<option value="">Pilih akun</option>${options}`;
  }

  function addJournalLine() {
    const row = document.createElement("tr");
    row.className = "journal-entry-row";
    row.innerHTML = `
      <td><select class="journal-line-account" aria-label="Akun jurnal" required>${journalAccountOptions()}</select></td>
      <td><input class="journal-line-debit" aria-label="Nominal debit" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></td>
      <td><input class="journal-line-credit" aria-label="Nominal kredit" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></td>
      <td><button class="icon-button remove-journal-line" type="button" aria-label="Hapus baris jurnal">×</button></td>`;
    $("#journal-entry-lines").append(row);
    updateJournalBalance();
  }

  function renderJournalAccountOptions() {
    document.querySelectorAll(".journal-line-account").forEach((select) => {
      const selectedId = select.value;
      select.innerHTML = journalAccountOptions(selectedId);
      if (selectedId) select.value = selectedId;
    });
  }

  function journalLineValues() {
    return [...document.querySelectorAll(".journal-entry-row")].map((row) => ({
      account_id: row.querySelector(".journal-line-account").value,
      debit: Number(row.querySelector(".journal-line-debit").value) || 0,
      credit: Number(row.querySelector(".journal-line-credit").value) || 0
    }));
  }

  function updateJournalBalance() {
    const lines = journalLineValues();
    const debitCents = lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0);
    const creditCents = lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0);
    const rowsAreValid = lines.length >= 2 && lines.every((line) =>
      line.account_id && line.debit >= 0 && line.credit >= 0
        && (line.debit > 0) !== (line.credit > 0)
    );
    const isBalanced = debitCents > 0 && debitCents === creditCents && rowsAreValid;
    $("#total-debit").textContent = money(debitCents / 100);
    $("#total-credit").textContent = money(creditCents / 100);
    const warning = $("#balance-warning");
    const submit = $("#post-journal-button");
    warning.classList.toggle("balanced", isBalanced);
    if (isBalanced) {
      warning.textContent = "Seimbang. Jurnal siap diposting.";
    } else if (debitCents !== creditCents) {
      warning.textContent = `Belum balance. Selisih ${money(Math.abs(debitCents - creditCents) / 100)} ${debitCents > creditCents ? "(debit lebih besar)" : "(kredit lebih besar)"}.`;
    } else {
      warning.textContent = "Isi setiap baris dengan akun dan hanya satu nominal debit atau kredit. Minimal dua baris diperlukan.";
    }
    submit.disabled = !isBalanced;
    return { isBalanced, lines };
  }

  function renderReports() {
    const posted = postedHeaders();
    const postedIds = new Set(posted.map((header) => header.id));
    const totals = Object.fromEntries(Object.keys(classifications).map((key) => [key, 0]));
    const accountTotals = new Map();
    state.lines.filter((line) => postedIds.has(line.header_id)).forEach((line) => {
      const account = state.accounts.find((item) => item.id === line.account_id);
      if (!account) return;
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      totals[account.report_classification] += debit + credit;
      const item = accountTotals.get(account.id) || { debit: 0, credit: 0 };
      item.debit += debit;
      item.credit += credit;
      accountTotals.set(account.id, item);
    });
    $("#report-cards").innerHTML = Object.entries(classifications).map(([key, label]) => `
      <article class="report-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(money(totals[key]))}</strong></article>`).join("");
    const accounts = [...state.accounts].sort((a, b) => String(a.account_code).localeCompare(String(b.account_code), "id", { numeric: true }));
    $("#report-table").innerHTML = accounts.length ? accounts.map((account) => {
      const amount = accountTotals.get(account.id) || { debit: 0, credit: 0 };
      return `<tr><td><strong>${escapeHtml(account.account_code)}</strong></td><td>${escapeHtml(account.account_name)}</td><td>${escapeHtml(classifications[account.report_classification] || account.report_classification)}</td><td class="align-right">${escapeHtml(money(amount.debit))}</td><td class="align-right">${escapeHtml(money(amount.credit))}</td></tr>`;
    }).join("") : emptyRow(5, "Belum ada akun untuk diringkas.");
  }

  async function loadData() {
    if (!state.config) {
      setConnected(false);
      renderAll();
      clearNotice();
      return;
    }
    clearNotice();
    try {
      const [accounts, headers, lines] = await Promise.all([
        supabaseRequest("chart_of_accounts?select=id,account_code,account_name,normal_balance,report_classification"),
        supabaseRequest("journal_headers?select=id,transaction_date,reference_number,description,status_posting,reverses_header_id"),
        supabaseRequest("journal_lines?select=id,header_id,account_id,debit,credit")
      ]);
      state.accounts = accounts;
      state.headers = headers;
      state.lines = lines;
      setConnected(true);
      renderAll();
    } catch (error) {
      setConnected(false);
      if (error.message.includes("reverses_header_id")) {
        showNotice("URL dan publishable key sudah tersimpan; database Supabase belum diperbarui. Jalankan ulang database/schema.sql di Supabase SQL Editor, lalu muat ulang halaman.", true);
        showToast("Koneksi tersimpan. Perbarui skema database agar jurnal dapat dimuat.", true);
      } else {
        showNotice(`Koneksi tersimpan, tetapi data belum dapat dimuat: ${error.message}`, true);
        showToast("Pengaturan tetap tersimpan. Periksa status project Supabase, skema, dan kebijakan akses.", true);
      }
    }
  }

  function openSettings() {
    const dialog = $("#settings-dialog");
    const form = $("#settings-form");
    form.elements.project_url.value = state.config?.url || "";
    form.elements.publishable_key.value = state.config?.key || "";
    dialog.showModal();
  }

  function navigate(viewName) {
    if (!titles[viewName]) return;
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
    document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === viewName));
    $("#page-title").textContent = titles[viewName][0];
    $("#page-eyebrow").textContent = titles[viewName][1];
  }

  function initDate() {
    const today = new Date();
    $("#today-label").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(today);
    $("#cash-out-form").elements.transaction_date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    addJournalLine();
    addJournalLine();
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-view]");
    if (link) {
      event.preventDefault();
      const viewName = link.dataset.view;
      if (window.location.hash !== `#${viewName}`) window.location.hash = viewName;
      navigate(viewName);
      return;
    }
    if (event.target.closest("#open-settings, #top-settings")) openSettings();
  });

  window.addEventListener("hashchange", () => navigate(window.location.hash.slice(1) || "dashboard"));

  $("#cancel-settings").addEventListener("click", () => $("#settings-dialog").close());
  $("#cancel-reversal").addEventListener("click", () => $("#reversal-dialog").close());
  $("#journals-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reverse-id]");
    if (!button) return;
    const form = $("#reversal-form");
    form.elements.header_id.value = button.dataset.reverseId;
    form.elements.transaction_date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    form.elements.reference_number.value = `STORNO-${button.dataset.reference}`.slice(0, 80);
    $("#reversal-dialog").showModal();
  });
  $("#add-journal-line").addEventListener("click", addJournalLine);
  $("#journal-entry-lines").addEventListener("input", updateJournalBalance);
  $("#journal-entry-lines").addEventListener("change", updateJournalBalance);
  $("#journal-entry-lines").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-journal-line");
    if (!button) return;
    if (document.querySelectorAll(".journal-entry-row").length <= 2) {
      showToast("Jurnal harus memiliki minimal dua baris.", true);
      return;
    }
    button.closest("tr").remove();
    updateJournalBalance();
  });
  $("#accounts-table").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-account]");
    if (editButton) {
      editAccount(editButton.dataset.editAccount);
      return;
    }
    const deleteButton = event.target.closest("[data-delete-account]");
    if (deleteButton) deleteAccount(deleteButton.dataset.deleteAccount);
  });
  $("#cancel-account-edit").addEventListener("click", resetAccountForm);
  $("#reversal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await supabaseRequest("rpc/reverse_journal", {
        method: "POST",
        body: JSON.stringify({
          p_header_id: form.elements.header_id.value,
          p_transaction_date: form.elements.transaction_date.value,
          p_reference_number: form.elements.reference_number.value.trim()
        })
      });
      $("#reversal-dialog").close();
      showToast("Jurnal pembalik berhasil dibuat dan diposting.");
      await loadData();
    } catch (error) {
      showToast(`Jurnal pembalik gagal dibuat: ${error.message}`, true);
    }
  });
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const url = form.elements.project_url.value.trim().replace(/\/+$/, "");
    const key = form.elements.publishable_key.value.trim();
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") throw new Error("Project URL harus memakai HTTPS.");
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, key }));
      state.config = { url, key };
      $("#settings-dialog").close();
      await loadData();
    } catch (error) {
      showToast(error.message || "Konfigurasi tidak dapat disimpan di browser ini.", true);
    }
  });

  $("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const accountId = form.elements.id.value;
    const values = Object.fromEntries([...new FormData(form).entries()].filter(([name]) => name !== "id"));
    try {
      const saved = await supabaseRequest(
        accountId ? `chart_of_accounts?id=eq.${encodeURIComponent(accountId)}` : "chart_of_accounts",
        {
        method: accountId ? "PATCH" : "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(values)
        }
      );
      if (!saved?.length) throw new Error("Akun tidak ditemukan atau tidak dapat diubah.");
      resetAccountForm();
      showToast(accountId ? "Perubahan akun berhasil disimpan." : "Akun berhasil disimpan.");
      await loadData();
    } catch (error) {
      showToast(`Akun gagal disimpan: ${error.message}`, true);
    }
  });

  $("#cash-out-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const { isBalanced, lines } = updateJournalBalance();
    if (!isBalanced) {
      showToast("Jurnal belum balance. Samakan total debit dan kredit sebelum posting.", true);
      return;
    }
    try {
      await supabaseRequest("rpc/create_journal_entry", {
        method: "POST",
        body: JSON.stringify({
          p_transaction_date: data.transaction_date,
          p_reference_number: data.reference_number.trim(),
          p_description: data.description.trim(),
          p_lines: lines
        })
      });
      const date = form.elements.transaction_date.value;
      form.reset();
      form.elements.transaction_date.value = date;
      $("#journal-entry-lines").replaceChildren();
      addJournalLine();
      addJournalLine();
      showToast("Jurnal berhasil disimpan dan diposting.");
      await loadData();
    } catch (error) {
      console.error("Gagal menyimpan jurnal.", error);
      showToast(explainJournalError(error), true);
    }
  });

  state.config = getConfig();
  initDate();
  navigate(window.location.hash.slice(1) || "dashboard");
  renderAll();
  loadData();
})();
