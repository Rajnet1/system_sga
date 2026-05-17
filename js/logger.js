/* Diagnostic logger with on-screen viewer.
 *
 * Buffers up to MAX_ENTRIES log records in memory, exposes window.Log.{info,
 * warn,error}, wires global window.onerror / unhandledrejection so even
 * uncaught failures show up, and renders a floating button + modal so the
 * user can copy the whole trace and send it to the developer.
 *
 * ERROR entries auto-open the modal (the user can't miss them). WARN and
 * INFO only update the badge counter.
 */
(function (global) {
  "use strict";

  var MAX_ENTRIES = 300;
  var entries = [];
  var errorCount = 0;
  var warnCount = 0;
  var els = {};
  var initDone = false;
  var pendingAutoOpen = false;

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function pad3(n) { return n < 10 ? "00" + n : n < 100 ? "0" + n : "" + n; }

  function timestamp() {
    var d = new Date();
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" +
      pad2(d.getSeconds()) + "." + pad3(d.getMilliseconds());
  }

  function safeStringify(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      var cache = [];
      return JSON.stringify(value, function (k, v) {
        if (typeof v === "object" && v !== null) {
          if (cache.indexOf(v) !== -1) return "[Circular]";
          cache.push(v);
        }
        if (v instanceof Error) return v.message + (v.stack ? "\n" + v.stack : "");
        return v;
      });
    } catch (e) {
      return String(value);
    }
  }

  function initOnce() {
    if (initDone) return;
    els.button = document.getElementById("log-button");
    els.badge = document.getElementById("log-badge");
    els.modal = document.getElementById("log-modal");
    els.modalClose = document.getElementById("log-modal-close");
    els.modalBody = document.getElementById("log-modal-body");
    els.modalCopy = document.getElementById("log-modal-copy");
    els.modalClear = document.getElementById("log-modal-clear");
    els.modalEmpty = document.getElementById("log-modal-empty");

    if (!els.button || !els.modal) return; /* DOM not ready yet */
    initDone = true;

    els.button.addEventListener("click", openModal);
    if (els.modalClose) els.modalClose.addEventListener("click", closeModal);
    els.modal.addEventListener("click", function (e) {
      if (e.target === els.modal) closeModal();
    });
    if (els.modalCopy) els.modalCopy.addEventListener("click", copyToClipboard);
    if (els.modalClear) els.modalClear.addEventListener("click", clearAll);

    /* Hydrate any entries logged before DOM was ready. */
    for (var i = 0; i < entries.length; i++) renderEntry(entries[i]);
    refreshEmptyState();
    updateBadge();
    if (pendingAutoOpen) {
      pendingAutoOpen = false;
      openModal();
    }
  }

  function add(level, msg, ctx) {
    var entry = {
      ts: timestamp(),
      level: level,
      msg: safeStringify(msg),
      ctx: ctx != null ? safeStringify(ctx) : "",
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();

    if (level === "ERROR") errorCount++;
    else if (level === "WARN") warnCount++;

    /* Mirror to native console for devs hitting F12. */
    var consoleArgs = ["[" + entry.ts + "] " + level + " " + entry.msg];
    if (entry.ctx) consoleArgs.push(entry.ctx);
    if (level === "ERROR" && typeof console !== "undefined" && console.error) console.error.apply(console, consoleArgs);
    else if (level === "WARN" && typeof console !== "undefined" && console.warn) console.warn.apply(console, consoleArgs);
    else if (typeof console !== "undefined" && console.log) console.log.apply(console, consoleArgs);

    initOnce();
    if (initDone) {
      renderEntry(entry);
      refreshEmptyState();
      updateBadge();
      flashButton(level);
    }

    if (level === "ERROR") {
      if (initDone) openModal();
      else pendingAutoOpen = true;
    }
  }

  function renderEntry(entry) {
    if (!els.modalBody) return;
    var row = document.createElement("div");
    row.className = "log-entry log-entry--" + entry.level.toLowerCase();
    var ts = document.createElement("span");
    ts.className = "log-entry__ts";
    ts.textContent = entry.ts;
    var lvl = document.createElement("span");
    lvl.className = "log-entry__level";
    lvl.textContent = entry.level;
    var msg = document.createElement("span");
    msg.className = "log-entry__msg";
    msg.textContent = entry.msg + (entry.ctx ? " — " + entry.ctx : "");
    row.appendChild(ts);
    row.appendChild(lvl);
    row.appendChild(msg);
    els.modalBody.appendChild(row);
    /* Keep view pinned to the newest entry. */
    els.modalBody.scrollTop = els.modalBody.scrollHeight;
  }

  function refreshEmptyState() {
    if (!els.modalEmpty) return;
    if (entries.length === 0) els.modalEmpty.removeAttribute("hidden");
    else els.modalEmpty.setAttribute("hidden", "");
  }

  function updateBadge() {
    if (!els.badge) return;
    var count = errorCount + warnCount;
    if (count === 0) {
      els.badge.setAttribute("hidden", "");
      els.badge.textContent = "";
      els.badge.classList.remove("log-badge--error");
      return;
    }
    els.badge.removeAttribute("hidden");
    els.badge.textContent = count > 99 ? "99+" : String(count);
    if (errorCount > 0) els.badge.classList.add("log-badge--error");
    else els.badge.classList.remove("log-badge--error");
  }

  var flashTimer = null;
  function flashButton(level) {
    if (!els.button) return;
    var cls = level === "ERROR" ? "log-button--flash-error" : "log-button--flash-warn";
    els.button.classList.add(cls);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      els.button.classList.remove("log-button--flash-error");
      els.button.classList.remove("log-button--flash-warn");
    }, 700);
  }

  function openModal() {
    initOnce();
    if (els.modal) els.modal.removeAttribute("hidden");
  }
  function closeModal() {
    if (els.modal) els.modal.setAttribute("hidden", "");
  }

  function envBlock() {
    var lines = [];
    lines.push("Wyszukiwarka szkol — log diagnostyczny");
    try { lines.push("Czas:       " + new Date().toISOString()); } catch (e) {}
    try { lines.push("URL:        " + location.href); } catch (e) {}
    try { lines.push("Origin:     " + location.origin); } catch (e) {}
    try { lines.push("UA:         " + navigator.userAgent); } catch (e) {}
    try { lines.push("Language:   " + navigator.language); } catch (e) {}
    try { lines.push("Screen:     " + screen.width + "x" + screen.height + " @ " + (window.devicePixelRatio || 1) + "x"); } catch (e) {}
    try {
      var keys = 0;
      for (var i = 0; i < localStorage.length; i++) keys++;
      lines.push("LocalStorage entries: " + keys);
    } catch (e) {}
    lines.push("Entries: " + entries.length + " (warn=" + warnCount + ", err=" + errorCount + ")");
    return lines.join("\n");
  }

  function formatAll() {
    var out = [envBlock(), "-----"];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var line = "[" + e.ts + "] " + e.level + "  " + e.msg;
      if (e.ctx) line += "   | " + e.ctx;
      out.push(line);
    }
    return out.join("\n");
  }

  function copyToClipboard() {
    var text = formatAll();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopyOk, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flashCopyOk();
    } catch (e) {
      /* Last resort: dump into the body so the user can select manually. */
      if (els.modalBody) {
        var pre = document.createElement("pre");
        pre.textContent = text;
        pre.style.whiteSpace = "pre-wrap";
        els.modalBody.appendChild(pre);
      }
    }
  }

  function flashCopyOk() {
    if (!els.modalCopy) return;
    var orig = els.modalCopy.dataset.origLabel || els.modalCopy.textContent;
    els.modalCopy.dataset.origLabel = orig;
    els.modalCopy.textContent = "Skopiowano ✓";
    setTimeout(function () { els.modalCopy.textContent = orig; }, 1500);
  }

  function clearAll() {
    entries.length = 0;
    errorCount = 0;
    warnCount = 0;
    if (els.modalBody) els.modalBody.innerHTML = "";
    refreshEmptyState();
    updateBadge();
  }

  /* Global error capture. */
  global.addEventListener("error", function (event) {
    var src = "";
    if (event && event.filename) {
      src = event.filename.split(/[\\/]/).pop() + ":" + (event.lineno || "?");
    }
    var msg = (event && event.message) || "Window error";
    var ctx = null;
    if (event && event.error && event.error.stack) ctx = event.error.stack;
    add("ERROR", msg + (src ? " (" + src + ")" : ""), ctx);
  });

  global.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var msg;
    var ctx = null;
    if (reason && reason.message) {
      msg = "Unhandled rejection: " + reason.message;
      if (reason.stack) ctx = reason.stack;
    } else {
      msg = "Unhandled rejection: " + safeStringify(reason);
    }
    add("ERROR", msg, ctx);
  });

  global.Log = {
    info: function (msg, ctx) { add("INFO", msg, ctx); },
    warn: function (msg, ctx) { add("WARN", msg, ctx); },
    error: function (msg, ctx) { add("ERROR", msg, ctx); },
    open: openModal,
    formatAll: formatAll,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOnce);
  } else {
    initOnce();
  }
})(window);
