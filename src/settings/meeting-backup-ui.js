import { LIBRARY_LOCK } from "../storage/library-lock.js";

const BACKUP_MODULE = "../../dist/meeting-backup.bundle.js";

function suggestedName(prefix) {
  const date = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${prefix}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`;
}

export function bindMeetingBackup(t) {
  const section = document.getElementById("meeting-backup");
  if (!section) return;
  const get = id => section.querySelector(`#backup-${id}`);
  const exportButton = get("export"), importButton = get("import"), input = get("file");
  const confirm = get("confirm"), cancel = get("cancel"), progress = get("progress");
  const status = get("status"), availability = get("availability");
  for (const id of ["title", "helper", "export", "import", "confirm", "cancel"]) {
    get(id).textContent = t(`backup.${id}`);
  }
  progress.setAttribute("aria-label", t("backup.progress"));
  let reason = "checking", controller = null, selectedFile = null, lastPercent = -1, refreshing = false;
  const reasonKey = () => `backup.${reason || "unavailable"}`;

  function render() {
    const running = controller !== null;
    exportButton.disabled = Boolean(reason || running || selectedFile);
    importButton.disabled = exportButton.disabled;
    confirm.hidden = !selectedFile;
    confirm.disabled = Boolean(reason || running);
    cancel.hidden = !running && !selectedFile;
    cancel.disabled = Boolean(controller?.signal.aborted);
    const message = !running && reason ? t(reasonKey()) : "";
    if (availability.textContent !== message) availability.textContent = message;
  }

  async function refresh() {
    if (refreshing || controller || document.hidden) return;
    refreshing = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "asterion:backup-status" });
      const { held } = await navigator.locks.query();
      reason = held.some(lock => lock.name === LIBRARY_LOCK && lock.mode === "exclusive")
        ? "busy" : response?.reason === null ? null : response?.reason ?? "unavailable";
    } catch { reason = "unavailable"; }
    finally { refreshing = false; render(); }
  }

  function announce(message, failed = false) {
    status.textContent = message;
    status.classList.toggle("is-error", failed);
  }

  function onProgress(bytes, total) {
    if (!total) return;
    const percent = Math.floor(bytes / total * 100);
    progress.value = percent;
    if (Math.floor(percent / 10) !== Math.floor(lastPercent / 10)) {
      lastPercent = percent;
      announce(t("backup.progressValue", { percent }));
    }
  }

  async function run(operation, focusTarget, { transfer = false } = {}) {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    progress.hidden = !transfer;
    progress.removeAttribute("value");
    lastPercent = -1;
    announce(t("backup.preparing"));
    render();
    try {
      await operation(current.signal);
    } catch (cause) {
      const code = cause.name === "AbortError" ? "cancelled" :
        cause.name === "QuotaExceededError" ? "space" : cause.code;
      const message = t(`backup.${code}`);
      announce(message === `backup.${code}` ? t(transfer ? "backup.transferError" : "backup.invalid") : message,
        code !== "cancelled");
    } finally {
      controller = null;
      progress.hidden = true;
      render();
      if (!document.activeElement || document.activeElement === document.body ||
          document.activeElement === cancel || document.activeElement === confirm) {
        if (selectedFile && !confirm.disabled) confirm.focus();
        else if (!focusTarget.disabled) focusTarget.focus();
      }
      void refresh();
    }
  }

  exportButton.addEventListener("click", () => {
    void run(async signal => {
      if (!window.showSaveFilePicker) throw Object.assign(new Error(), { code: "pickerUnavailable" });
      const handle = await window.showSaveFilePicker({
        suggestedName: suggestedName(t("backup.filenamePrefix")), types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
      });
      const { withBackupLibrary, exportMeetingBackup } = await import(BACKUP_MODULE);
      const result = await withBackupLibrary(async () => {
        const root = await navigator.storage.getDirectory();
        const writable = await handle.createWritable();
        try { return await exportMeetingBackup(root, writable, { signal, onProgress }); }
        catch (cause) { await writable.abort().catch(() => {}); throw cause; }
      }, signal);
      announce(t(result.skipped ? "backup.exportedPartial" : "backup.exported", result));
    }, exportButton, { transfer: true });
  });

  importButton.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    void run(async signal => {
      const { withBackupLibrary, previewMeetingBackup } = await import(BACKUP_MODULE);
      const preview = await withBackupLibrary(async () => previewMeetingBackup(await navigator.storage.getDirectory(), file, signal), signal);
      selectedFile = file;
      announce(t("backup.preview", preview));
    }, importButton);
  });

  confirm.addEventListener("click", () => {
    const file = selectedFile;
    if (!file) return;
    void run(async signal => {
      const { withBackupLibrary, importMeetingBackup } = await import(BACKUP_MODULE);
      const result = await withBackupLibrary(async () => importMeetingBackup(await navigator.storage.getDirectory(), file, { signal, onProgress }), signal);
      selectedFile = null;
      announce(t("backup.imported", result));
    }, importButton, { transfer: true });
  });

  cancel.addEventListener("click", () => {
    if (controller) {
      controller.abort();
      render();
    } else {
      selectedFile = null;
      announce(t("backup.cancelled"));
      render();
      importButton.focus();
    }
  });

  const timer = setInterval(refresh, 2000);
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    controller?.abort();
  }, { once: true });
  document.addEventListener("visibilitychange", refresh);
  render();
  void refresh();
}
