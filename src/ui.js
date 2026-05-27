import { CATEGORIES } from "./partsdb.js";

export class Sidebar {
  constructor(container, summaryEl) {
    this.container = container;
    this.summaryEl = summaryEl;
    this.itemsByMesh = new Map();
    this.itemElements = new Map();
    this.onItemClick = null;
  }

  render(classification) {
    this.container.innerHTML = "";
    this.itemsByMesh.clear();
    this.itemElements.clear();
    const { byCategory, items } = classification;

    let total = 0;
    let identified = 0;
    for (const it of items) {
      total += it.quantity;
      if (it.part) identified += it.quantity;
    }
    this.summaryEl.textContent =
      total === 0
        ? "No parts detected"
        : `${total} parts found · ${identified} identified (${Math.round(
            (identified / total) * 100,
          )}%)`;

    for (const catId of Object.keys(CATEGORIES)) {
      const cat = CATEGORIES[catId];
      const list = byCategory.get(catId) || [];
      const empty = list.length === 0;
      const lineCount = list.length;
      const partCount = list.reduce((s, l) => s + l.quantity, 0);

      const section = document.createElement("div");
      section.className = "category" + (lineCount ? " open" : "");
      section.dataset.empty = empty ? "true" : "false";
      section.dataset.category = catId;
      section.innerHTML = `
        <div class="category-header">
          <div class="cat-left">
            <span class="cat-swatch" style="background:${cat.color}"></span>
            <span class="cat-title">${cat.label}</span>
          </div>
          <div class="cat-right">
            <span class="cat-count">${partCount}</span>
            <span class="cat-chevron">▶</span>
          </div>
        </div>
        <div class="cat-body"></div>
      `;

      const body = section.querySelector(".cat-body");
      if (empty) {
        body.innerHTML = `<div class="part-item" style="cursor:default"><div><div class="name muted">No parts in this category</div><div class="meta">${cat.description}</div></div></div>`;
      } else {
        for (const item of list) body.appendChild(this._renderItem(item));
      }

      section.querySelector(".category-header").addEventListener("click", () => {
        section.classList.toggle("open");
      });
      this.container.appendChild(section);
    }
  }

  _renderItem(item) {
    const el = document.createElement("div");
    el.className = "part-item";

    const conf = Math.round((item.avgConfidence || 0) * 100);
    const dims = item.sampleFeatures.dims
      .map((d) => (d >= 1 ? d.toFixed(2) : d.toFixed(3)))
      .join(" × ");

    el.innerHTML = `
      <div class="part-info">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="meta">${dims} in · ${conf}% match</div>
      </div>
      <div class="qty">×${item.quantity}</div>
      <div class="actions">
        ${
          item.part
            ? `<a class="btn primary small" href="${item.part.vexUrl}" target="_blank" rel="noopener">Order on VEX</a>
               <a class="btn ghost small" href="${item.part.roboUrl}" target="_blank" rel="noopener">Robosource</a>`
            : `<span class="muted small">No matching catalog entry</span>`
        }
      </div>
    `;
    el.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      this.onItemClick?.(item);
    });
    for (const m of item.meshes) this.itemsByMesh.set(m, item);
    this.itemElements.set(item.key, el);
    return el;
  }

  highlightMesh(mesh) {
    this.container
      .querySelectorAll(".part-item.selected")
      .forEach((el) => el.classList.remove("selected"));
    if (!mesh) return;
    const item = this.itemsByMesh.get(mesh);
    if (!item) return;
    const el = this.itemElements.get(item.key);
    if (el) {
      el.classList.add("selected");
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el.closest(".category")?.classList.add("open");
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

export function showToast(message, { error = false, duration = 3200 } = {}) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.toggle("error", !!error);
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), duration);
}
