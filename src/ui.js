import { escapeHtml as e } from "./format.js";
export const $ = (selector, root = document) => root.querySelector(selector);
export function icon(name) {
  const paths = {
    invoice: "M7 3h10v18l-5-3-5 3z M10 7h4 M10 11h4",
    suppliers: "M4 21v-9h16v9 M3 8l2-5h14l2 5v4H3z M9 21v-6h6v6",
    cash: "M3 5h18v14H3z M16 9h5v6h-5z M6 9h5",
    reports: "M4 3v18h17 M8 17v-6 M13 17V7 M18 17V4",
    plus: "M12 5v14 M5 12h14",
    camera: "M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    check: "M5 12l4 4L19 6",
    close: "M6 6l12 12 M6 18L18 6",
    search: "M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    settings:
      "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
    arrow: "M15 5l-7 7 7 7",
    download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
    refresh:
      "M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 3 M19 16a8 8 0 0 1-13 3l-2-3",
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(
    paths[name] || paths.invoice
  )
    .split(" M")
    .map((p, i) => `<path d="${i ? "M" : ""}${p}"/>`)
    .join("")}</svg>`;
}
export function field(
  label,
  name,
  value = "",
  {
    type = "text",
    required = false,
    placeholder = "",
    hint = "",
    wide = false,
    read = "",
    uncertain = false,
  } = {},
) {
  return `<label class="field ${wide ? "wide" : ""} ${uncertain ? "uncertain" : ""}"><span>${e(label)}${required ? ' <span class="required">*</span>' : ""}</span>${read ? `<small class="read-value">נקרא: ${e(read)}</small>` : ""}<input name="${e(name)}" type="${type}" value="${e(value)}" ${required ? "required" : ""} ${type === "text" && /Agorot|amount|total|subtotal|vat|final|cash|ravKav/.test(name) ? 'inputmode="decimal"' : ""} ${type === "date" ? 'min="1900-01-01" max="2200-12-31"' : ""} placeholder="${e(placeholder)}" autocomplete="off">${hint ? `<small>${e(hint)}</small>` : ""}</label>`;
}
export function select(
  label,
  name,
  value,
  options,
  { wide = false, required = false } = {},
) {
  return `<label class="field ${wide ? "wide" : ""}"><span>${e(label)}${required ? " *" : ""}</span><select name="${e(name)}" ${required ? "required" : ""}>${Object.entries(
    options,
  )
    .map(
      ([v, l]) =>
        `<option value="${e(v)}" ${v === value ? "selected" : ""}>${e(l)}</option>`,
    )
    .join("")}</select></label>`;
}
export function empty(title, subtitle, button = "") {
  return `<div class="empty"><span class="empty-icon">${icon("invoice")}</span><h2>${e(title)}</h2><p>${e(subtitle)}</p>${button}</div>`;
}
export function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast visible" + (error ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => el.classList.remove("visible"),
    error ? 9000 : 3500,
  );
}
export function errorText(error) {
  return (
    (error.message || "הפעולה לא הושלמה.") +
    (error.requestId ? " (קוד בדיקה: " + error.requestId.slice(0, 8) + ")" : "")
  );
}
export function formObject(form) {
  return Object.fromEntries(new FormData(form));
}
