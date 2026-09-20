// 呈现模块：只负责页面渲染与事件转发，业务判定交给 rules / flow。
import { SLOTS, slotById, weekdayOf } from "./rules.js";
import {
  STATUSES,
  PRIORITIES,
  addRepair,
  submitBatch,
  markArrived,
  cancelBooking,
  rescheduleDoing,
  completeRepair,
  deleteRepair,
  saveDraft,
  totalOpenCost
} from "./flow.js";

let state;
let persist;
const app = document.querySelector("#app");

// 只在内存中保留的临时交互态（报错、展开的内联表单），不进存档
const ui = {
  batchErrors: {},
  batchSummary: "",
  openCancelId: null,
  cancelReason: "",
  cancelError: "",
  openRescheduleId: null,
  reschedule: { date: "", slotId: "", worker: "" },
  rescheduleError: "",
  notice: ""
};

function emptyDraft() {
  return { date: "", slotId: "", worker: "" };
}

export function startApp(initialState, persistFn) {
  state = initialState;
  persist = persistFn;
  render();
}

function render() {
  const todos = state.repairs.filter((repair) => repair.status === "todo");
  const bookedCount = state.repairs.filter((repair) => repair.status === "booked").length;
  const doingCount = state.repairs.filter((repair) => repair.status === "doing").length;
  const openCount = state.repairs.filter((repair) => repair.status !== "done").length;
  const totalCost = totalOpenCost(state.repairs);
  const workers = [...new Set(state.repairs.map((repair) => repair.worker).filter(Boolean))];

  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">本地家庭维护台</p>
          <h1>家庭维修 · 上门排期台</h1>
          <p class="subtitle">按日期与两小时时段预约师傅；字段缺失或时段撞车将整批退回。</p>
        </div>
        <section class="stats">
          <div class="stat"><span>未完成</span><strong>${openCount}</strong></div>
          <div class="stat"><span>已预约</span><strong>${bookedCount}</strong></div>
          <div class="stat"><span>处理中</span><strong>${doingCount}</strong></div>
          <div class="stat"><span>预计费用</span><strong>¥${totalCost}</strong></div>
        </section>
      </header>

      <section class="layout">
        <aside class="panel">
          <h2>新增维修事项</h2>
          <form class="form" id="repair-form">
            <label>位置<input name="location" required placeholder="例如卫生间"></label>
            <label>问题描述<textarea name="title" required placeholder="例如门锁松动"></textarea></label>
            <label>优先级<select name="priority">${renderPriorityOptions("medium")}</select></label>
            <label>预计费用<input name="cost" type="number" min="0" step="1" value="0"></label>
            <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址"></label>
            <label>备注<textarea name="note" placeholder="材料、故障现象或注意事项"></textarea></label>
            <button class="primary" type="submit">保存事项</button>
            <p class="hint">新事项进入「待处理」，在右侧排期台统一预约。</p>
          </form>
        </aside>

        <section class="main-col">
          ${todos.length ? renderBatchDesk(todos, workers) : ""}

          <div class="toolbar">
            ${Object.entries(STATUSES).map(
              ([value, label]) =>
                `<button type="button" class="seg ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`
            ).join("")}
          </div>
          ${ui.notice ? `<div class="notice">${escapeHtml(ui.notice)}</div>` : ""}
          <div class="repairs">
            ${renderFilteredList()}
          </div>
        </section>
      </section>
    </main>
  `;

  bindEvents();
}

function renderBatchDesk(todos, workers) {
  const errorCount = Object.keys(ui.batchErrors).length;
  return `
    <section class="panel desk">
      <div class="desk-head">
        <h2>批量排期 · ${todos.length} 个待办</h2>
        <p class="hint">为每条待办选择日期、两小时时段与师傅，一次整批提交。同一位师傅在交叠时段只能承接一单。</p>
      </div>
      ${
        ui.batchSummary
          ? `<div class="banner error"><strong>整批退回，未产生任何预约。</strong>${escapeHtml(ui.batchSummary)}</div>`
          : ""
      }
      <div class="desk-rows">
        ${todos.map((repair) => renderDraftRow(repair)).join("")}
      </div>
      <div class="desk-foot">
        <button type="button" class="primary" id="batch-submit">整批提交预约</button>
        ${errorCount ? `<span class="row-error">${errorCount} 条待办未通过校验，草稿已原样保留</span>` : ""}
      </div>
      <datalist id="workers">${workers.map((worker) => `<option value="${escapeHtml(worker)}"></option>`).join("")}</datalist>
    </section>
  `;
}

function renderDraftRow(repair) {
  const draft = state.drafts[repair.id] || emptyDraft();
  const error = ui.batchErrors[repair.id];
  return `
    <div class="draft-row ${error ? "has-error" : ""}">
      <div class="draft-meta">
        <strong>${escapeHtml(repair.location)}</strong>
        <span>${escapeHtml(repair.title)}</span>
      </div>
      <div class="draft-fields">
        <label>日期
          <input type="date" data-draft="${repair.id}" data-field="date" value="${escapeHtml(draft.date || "")}" min="${todayValue()}">
        </label>
        <label>时段
          <select data-draft="${repair.id}" data-field="slotId">
            <option value="">选择两小时时段</option>
            ${SLOTS.map((slot) => `<option value="${slot.id}" ${draft.slotId === slot.id ? "selected" : ""}>${slot.label}</option>`).join("")}
          </select>
        </label>
        <label>师傅
          <input type="text" data-draft="${repair.id}" data-field="worker" list="workers" value="${escapeHtml(draft.worker || "")}" placeholder="师傅姓名">
        </label>
      </div>
      ${error ? `<p class="row-error">${escapeHtml(error)}</p>` : ""}
    </div>
  `;
}

function renderFilteredList() {
  const repairs = filteredRepairs();
  if (!repairs.length) return `<div class="empty">当前筛选下没有维修事项</div>`;
  return repairs.map(renderRepair).join("");
}

function renderRepair(repair) {
  return `
    <article class="repair">
      <div class="photo">${
        repair.photo
          ? `<img src="${escapeHtml(repair.photo)}" alt="${escapeHtml(repair.location)}维修照片">`
          : "未添加照片"
      }</div>
      <div class="content">
        <div class="row">
          <h3>${escapeHtml(repair.location)}</h3>
          <span class="priority ${repair.priority}">${PRIORITIES[repair.priority] || PRIORITIES.medium}</span>
          <span class="status ${repair.status}">${STATUSES[repair.status] || repair.status}</span>
        </div>
        <p>${escapeHtml(repair.title)}</p>
        ${renderSchedule(repair)}
        <div class="row">
          <span class="chip">预计 ¥${Number(repair.cost || 0)}</span>
          <span class="chip">${escapeHtml(repair.note || "暂无备注")}</span>
        </div>
        ${renderActions(repair)}
      </div>
    </article>
  `;
}

function renderSchedule(repair) {
  if (repair.status === "booked" || repair.status === "doing") {
    const slot = slotById(repair.slotId);
    return `
      <div class="schedule">
        <span class="chip schedule-chip">📅 ${escapeHtml(repair.date)} ${weekdayOf(repair.date)} ${slot ? slot.label : ""}</span>
        <span class="chip schedule-chip">🔧 ${escapeHtml(repair.worker)}</span>
        ${repair.status === "doing" ? `<span class="chip doing-chip">师傅已到场</span>` : `<span class="chip booked-chip">等待到场</span>`}
      </div>`;
  }
  if (repair.status === "todo" && repair.cancelReason) {
    return `<div class="schedule"><span class="chip cancel-chip">上次取消缘由：${escapeHtml(repair.cancelReason)}</span></div>`;
  }
  return "";
}

function renderActions(repair) {
  if (repair.status === "booked") {
    const open = ui.openCancelId === repair.id;
    return `
      <div class="actions">
        <button type="button" class="primary small" data-arrive="${repair.id}">师傅已到场</button>
        <button type="button" class="danger ghost" data-cancel="${repair.id}">取消预约</button>
      </div>
      ${
        open
          ? `
        <form class="inline-form" data-cancel-form="${repair.id}">
          <label>取消缘由（必填，提交后让出该时段）
            <textarea name="reason" placeholder="例如业主临时出差、师傅突发状况">${escapeHtml(ui.cancelReason)}</textarea>
          </label>
          ${ui.cancelError ? `<p class="row-error">${escapeHtml(ui.cancelError)}</p>` : ""}
          <div class="actions">
            <button type="submit" class="danger small">确认取消并让出时段</button>
            <button type="button" class="ghost small" data-cancel-close>再想想</button>
          </div>
        </form>`
          : ""
      }`;
  }
  if (repair.status === "doing") {
    const open = ui.openRescheduleId === repair.id;
    return `
      <div class="actions">
        <button type="button" class="primary small" data-complete="${repair.id}">维修完成</button>
        <button type="button" class="ghost small" data-reschedule="${repair.id}">改期</button>
      </div>
      ${
        open
          ? `
        <form class="inline-form" data-reschedule-form="${repair.id}">
          <div class="draft-fields">
            <label>日期<input type="date" name="date" min="${todayValue()}" value="${escapeHtml(ui.reschedule.date)}"></label>
            <label>时段
              <select name="slotId">
                <option value="">选择两小时时段</option>
                ${SLOTS.map(
                  (slot) =>
                    `<option value="${slot.id}" ${ui.reschedule.slotId === slot.id ? "selected" : ""}>${slot.label}</option>`
                ).join("")}
              </select>
            </label>
            <label>师傅<input type="text" name="worker" list="workers" value="${escapeHtml(ui.reschedule.worker)}"></label>
          </div>
          ${ui.rescheduleError ? `<p class="row-error">${escapeHtml(ui.rescheduleError)}</p>` : ""}
          <div class="actions">
            <button type="submit" class="small">保存改期</button>
            <button type="button" class="ghost small" data-reschedule-close>放弃</button>
          </div>
        </form>`
          : ""
      }`;
  }
  return `
    <div class="actions">
      <button type="button" class="ghost" data-delete="${repair.id}">删除</button>
    </div>`;
}

function renderPriorityOptions(selected) {
  return Object.entries(PRIORITIES)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function bindEvents() {
  const form = document.querySelector("#repair-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    addRepair(state, data);
    persist(state);
    ui.notice = "";
    render();
  });

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      persist(state);
      render();
    });
  });

  document.querySelectorAll("[data-draft]").forEach((input) => {
    const sync = () => {
      const id = input.dataset.draft;
      const draft = state.drafts[id] || emptyDraft();
      draft[input.dataset.field] = input.value;
      saveDraft(state, id, draft);
      persist(state);
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });

  const batchSubmit = document.querySelector("#batch-submit");
  if (batchSubmit) {
    batchSubmit.addEventListener("click", () => {
      const entries = state.repairs
        .filter((repair) => repair.status === "todo")
        .map((repair) => ({ repairId: repair.id, ...(state.drafts[repair.id] || emptyDraft()) }));
      const result = submitBatch(state, entries);
      if (!result.ok) {
        ui.batchErrors = result.errors;
        ui.batchSummary = `共有 ${Object.keys(result.errors).length} 条待办字段不全或时段撞车，所有事项与草稿均保持原样。`;
      } else {
        ui.batchErrors = {};
        ui.batchSummary = "";
        ui.notice = `已提交 ${entries.length} 个预约，师傅时段已锁定。`;
        persist(state);
      }
      render();
    });
  }

  document.querySelectorAll("[data-arrive]").forEach((button) => {
    button.addEventListener("click", () => {
      markArrived(state, button.dataset.arrive);
      ui.notice = "师傅已到场，事项转为处理中。";
      persist(state);
      render();
    });
  });

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => {
      completeRepair(state, button.dataset.complete);
      resetInline();
      ui.notice = "维修已完成，时段已释放。";
      persist(state);
      render();
    });
  });

  document.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      const repair = state.repairs.find((item) => item.id === button.dataset.cancel);
      ui.openCancelId = repair.id;
      ui.cancelReason = "";
      ui.cancelError = "";
      render();
    });
  });

  document.querySelectorAll("[data-cancel-close]").forEach((button) => {
    button.addEventListener("click", () => {
      resetInline();
      render();
    });
  });

  document.querySelectorAll("[data-cancel-form]").forEach((formEl) => {
    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const reason = new FormData(formEl).get("reason");
      const error = cancelBooking(state, formEl.dataset.cancelForm, String(reason || ""));
      if (error) {
        ui.cancelError = error;
      } else {
        resetInline();
        ui.notice = "预约已取消，时段已让出，事项回到待处理。";
        persist(state);
      }
      render();
    });
  });

  document.querySelectorAll("[data-reschedule]").forEach((button) => {
    button.addEventListener("click", () => {
      const repair = state.repairs.find((item) => item.id === button.dataset.reschedule);
      ui.openRescheduleId = repair.id;
      ui.reschedule = { date: repair.date, slotId: repair.slotId, worker: repair.worker };
      ui.rescheduleError = "";
      render();
    });
  });

  document.querySelectorAll("[data-reschedule-close]").forEach((button) => {
    button.addEventListener("click", () => {
      resetInline();
      render();
    });
  });

  document.querySelectorAll("[data-reschedule-form]").forEach((formEl) => {
    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(formEl));
      const result = rescheduleDoing(state, formEl.dataset.rescheduleForm, {
        date: String(data.date || ""),
        slotId: String(data.slotId || ""),
        worker: String(data.worker || "")
      });
      if (!result.ok) {
        ui.rescheduleError = result.error;
      } else {
        resetInline();
        ui.notice = "改期成功。";
        persist(state);
      }
      render();
    });
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      deleteRepair(state, button.dataset.delete);
      resetInline();
      persist(state);
      render();
    });
  });
}

function resetInline() {
  ui.openCancelId = null;
  ui.cancelReason = "";
  ui.cancelError = "";
  ui.openRescheduleId = null;
  ui.reschedule = emptyDraft();
  ui.rescheduleError = "";
}

function filteredRepairs() {
  if (state.filter === "all") return state.repairs;
  return state.repairs.filter((repair) => repair.status === state.filter);
}

function todayValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]
  );
}
