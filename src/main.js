// 呈现模块：只负责渲染与 DOM 交互；规则来自 rules.js，数据流转来自 flow.js。
import "./styles.css";
import {
  SLOT_START_HOURS,
  filterRepairs,
  findActiveAppointment,
  isActive,
  latestBookedDate,
  schedulableRepairs,
  slotRangeText,
  sumCost
} from "./rules.js";
import { createStore, loadState } from "./flow.js";

const statuses = {
  all: "全部",
  todo: "待处理",
  doing: "处理中",
  done: "已完成"
};

const priorities = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

const appStatusLabels = {
  booked: "已排期待到场",
  arrived: "师傅已到场",
  cancelled: "已取消",
  completed: "已完成"
};

const app = document.querySelector("#app");
const store = createStore(loadState());

// 仅存于界面的临时状态（草稿、横幅），不写入浏览器存档。
const ui = {
  banner: null,
  addDraft: null,
  batchRows: [],
  cancelOpen: null,
  rescheduleOpen: null,
  rescheduleDraft: null
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function weekdayText(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return names[new Date(`${date}T00:00:00`).getDay()];
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function workerOptions(appointments, selected = "") {
  const names = [...new Set(appointments.map((item) => item.worker).filter(Boolean))].sort();
  const all = new Set([...names, selected].filter(Boolean));
  return [...all]
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}" ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>`
    )
    .join("");
}

function slotOptions(selected) {
  return SLOT_START_HOURS.map(
    (start) =>
      `<option value="${start}" ${Number(selected) === start ? "selected" : ""}>${slotRangeText(start)}</option>`
  ).join("");
}

function renderPriorityOptions(selected) {
  return Object.entries(priorities)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function showBanner(type, text) {
  ui.banner = { type, text };
}

function ensureBatchRows(count) {
  while (ui.batchRows.length < count) {
    ui.batchRows.push({ repairId: "", date: todayText(), start: "", worker: "" });
  }
  if (ui.batchRows.length > count) ui.batchRows.length = count;
}

function render() {
  const state = store.getState();
  const visible = filterRepairs(state.repairs, state.filter);
  const unfinished = state.repairs.filter((repair) => repair.status !== "done");
  const doing = state.repairs.filter((repair) => repair.status === "doing");
  const awaiting = state.appointments.filter((item) => item.status === "booked").length;
  const visibleCost = sumCost(visible);

  if (!ui.batchRows.length) ensureBatchRows(1);

  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">本地家庭维护台</p>
          <h1>上门排期台</h1>
          <p class="subtitle">待办事项按日期与两小时时段预约师傅，同师傅交叠时段只承接一单。</p>
        </div>
        <section class="stats">
          <div class="stat"><span>未完成事项</span><strong>${unfinished.length}</strong></div>
          <div class="stat"><span>处理中</span><strong>${doing.length}</strong></div>
          <div class="stat"><span>待到场预约</span><strong>${awaiting}</strong></div>
          <div class="stat wide"><span>预计费用合计（当前筛选：${statuses[state.filter]}）</span><strong>¥${visibleCost}</strong></div>
        </section>
      </header>

      ${ui.banner ? `<div class="banner ${ui.banner.type}">${escapeHtml(ui.banner.text)}</div>` : ""}

      <section class="layout">
        <aside class="side">
          <section class="panel">
            <h2>新增维修事项</h2>
            <p class="panel-note">新事项先进入「待处理」，再通过批量排期约师傅。</p>
            <form class="form" id="repair-form">
              <label>位置<input name="location" required placeholder="例如卫生间" value="${escapeHtml(ui.addDraft?.location || "")}"></label>
              <label>问题描述<textarea name="title" required placeholder="例如门锁松动">${escapeHtml(ui.addDraft?.title || "")}</textarea></label>
              <label>优先级<select name="priority">${renderPriorityOptions(ui.addDraft?.priority || "medium")}</select></label>
              <label>预计费用<input name="cost" type="number" min="0" step="1" value="${escapeHtml(ui.addDraft?.cost ?? "0")}"></label>
              <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址" value="${escapeHtml(ui.addDraft?.photo || "")}"></label>
              <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项">${escapeHtml(ui.addDraft?.note || "")}</textarea></label>
              <button class="primary" type="submit">保存事项</button>
            </form>
          </section>
          ${renderAgenda(state)}
        </aside>

        <section class="main-col">
          ${renderBatchPanel(state)}

          <div class="toolbar">
            ${Object.entries(statuses)
              .map(
                ([value, label]) =>
                  `<button type="button" class="seg ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`
              )
              .join("")}
          </div>
          <div class="repairs">
            ${visible.length ? visible.map((repair) => renderRepair(repair, state.appointments)).join("") : `<div class="empty">当前筛选下没有维修事项</div>`}
          </div>

          ${renderCancelled(state)}
        </section>
      </section>
    </main>
  `;

  bindEvents();
}

function renderAgenda(state) {
  const active = state.appointments.filter(isActive);
  if (!active.length) {
    return `<section class="panel"><h2>近期排期</h2><p class="empty-inline">暂无生效中的预约</p></section>`;
  }
  const groups = new Map();
  active
    .slice()
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1))
    .forEach((appointment) => {
      if (!groups.has(appointment.date)) groups.set(appointment.date, []);
      groups.get(appointment.date).push(appointment);
    });
  return `
    <section class="panel">
      <h2>近期排期</h2>
      <ul class="agenda">
        ${[...groups.entries()]
          .map(
            ([date, items]) => `
            <li>
              <p class="agenda-date">${date} ${weekdayText(date)}</p>
              ${items
                .map((appointment) => {
                  const repair = state.repairs.find((item) => item.id === appointment.repairId);
                  return `
                  <div class="agenda-item ${appointment.status}">
                    <span class="agenda-slot">${slotRangeText(appointment.start)}</span>
                    <span>${escapeHtml(appointment.worker)}</span>
                    <span class="muted">${repair ? escapeHtml(repair.location) : "事项已删除"}</span>
                    <span class="mini-status ${appointment.status}">${appStatusLabels[appointment.status]}</span>
                  </div>`;
                })
                .join("")}
            </li>`
          )
          .join("")}
      </ul>
    </section>
  `;
}

function renderBatchPanel(state) {
  const schedulable = schedulableRepairs(state.repairs, state.appointments);
  const repairOptionsFor = (selected) =>
    `<option value="">选择待办事项…</option>` +
    schedulable
      .map(
        (repair) =>
          `<option value="${repair.id}" ${repair.id === selected ? "selected" : ""}>${escapeHtml(repair.location)} · ${escapeHtml(repair.title)}</option>`
      )
      .join("");

  return `
    <section class="panel batch-panel">
      <div class="panel-head">
        <h2>批量预约上门</h2>
        <span class="panel-note">一次性提交多行；任一字段不全或师傅时段撞车，整批退回，事项与排期保持原样。</span>
      </div>
      ${schedulable.length ? "" : `<p class="empty-inline">没有可排期的待处理事项（已有生效预约的事项不能重复排期）。</p>`}
      <form id="batch-form" ${schedulable.length ? "" : "hidden"}>
        <div id="batch-rows">
          ${ui.batchRows
            .map(
              (row, index) => `
            <div class="batch-row" data-row="${index}">
              <select data-field="repairId" data-row="${index}">${repairOptionsFor(row.repairId)}</select>
              <input type="date" data-field="date" data-row="${index}" value="${escapeHtml(row.date)}">
              <select data-field="start" data-row="${index}">
                <option value="">时段…</option>${slotOptions(row.start)}
              </select>
              <input type="text" list="worker-list" data-field="worker" data-row="${index}" placeholder="师傅称呼" value="${escapeHtml(row.worker)}">
              <button type="button" class="icon-btn" data-row-remove="${index}" title="删除此行" ${ui.batchRows.length === 1 ? "disabled" : ""}>×</button>
            </div>`
            )
            .join("")}
        </div>
        <datalist id="worker-list">${workerOptions(state.appointments)}</datalist>
        <div class="batch-actions">
          <button type="button" class="ghost" id="add-row">加一行</button>
          <button type="submit" class="primary">整批提交排期</button>
        </div>
      </form>
    </section>
  `;
}

function renderRepair(repair, appointments) {
  const appointment = findActiveAppointment(appointments, repair.id);
  return `
    <article class="repair">
      <div class="photo">${repair.photo ? `<img src="${escapeHtml(repair.photo)}" alt="${escapeHtml(repair.location)}维修照片">` : "未添加照片"}</div>
      <div class="content">
        <div class="row">
          <h3>${escapeHtml(repair.location)}</h3>
          <span class="priority ${repair.priority}">${priorities[repair.priority]}</span>
          <span class="status ${repair.status}">${statuses[repair.status]}</span>
        </div>
        <p>${escapeHtml(repair.title)}</p>
        ${renderBooking(repair, appointment, appointments)}
        <div class="row">
          <span class="chip">预计 ¥${Number(repair.cost || 0)}</span>
          <span class="chip">${escapeHtml(repair.note || "暂无备注")}</span>
        </div>
        <div class="actions">
          ${repair.status === "doing" ? `<button type="button" class="ghost" data-complete="${repair.id}">标记完成</button>` : ""}
          <button type="button" class="ghost danger" data-delete="${repair.id}">删除事项</button>
        </div>
      </div>
    </article>
  `;
}

function renderBooking(repair, appointment, appointments) {
  if (!appointment) {
    return `<p class="muted small">尚未预约：在上方「批量预约上门」中选择本事项安排日期、两小时时段与师傅。</p>`;
  }

  const head = `
    <div class="booking ${appointment.status}">
      <div class="booking-head">
        <span class="mini-status ${appointment.status}">${appStatusLabels[appointment.status]}</span>
        <span class="chip">${appointment.date} ${weekdayText(appointment.date)}</span>
        <span class="chip">${slotRangeText(appointment.start)}</span>
        <span class="chip">${escapeHtml(appointment.worker)}师傅</span>
      </div>`;

  if (appointment.status === "booked") {
    const isCancelOpen = ui.cancelOpen === appointment.id;
    return `
      ${head}
      <div class="booking-actions">
        <button type="button" class="primary small" data-arrive="${repair.id}">师傅已到场</button>
        <button type="button" class="ghost" data-cancel="${appointment.id}">取消预约</button>
      </div>
      ${
        isCancelOpen
          ? `
        <form class="inline-form" data-cancel-form="${appointment.id}">
          <label class="grow">取消缘由（必填，提交后让出该时段）
            <input name="reason" required placeholder="例如客户临时出差、师傅家中有事">
          </label>
          <button type="submit" class="ghost danger">确认取消并让出时段</button>
          <button type="button" class="ghost" data-cancel-close>收起</button>
        </form>`
          : ""
      }
    </div>`;
  }

  if (appointment.status === "arrived" && repair.status === "doing") {
    const isOpen = ui.rescheduleOpen === repair.id;
    const cutoff = latestBookedDate(appointments);
    const draft = ui.rescheduleDraft || {
      date: appointment.date,
      start: appointment.start,
      worker: appointment.worker
    };
    return `
      ${head}
      <div class="booking-actions">
        <button type="button" class="ghost" data-reschedule="${repair.id}">${isOpen ? "收起改期" : "处理中改期"}</button>
      </div>
      ${
        isOpen
          ? `
        <form class="inline-form" data-reschedule-form="${repair.id}">
          <label>改到日期<input type="date" name="date" required value="${escapeHtml(draft.date)}"></label>
          <label>时段<select name="start">${slotOptions(draft.start)}</select></label>
          <label>师傅<input type="text" name="worker" list="worker-list" required value="${escapeHtml(draft.worker)}"></label>
          <button type="submit" class="primary small">确认改期</button>
        </form>
        <p class="rule-note">规则：日期不能晚于已排待到场事项的最晚日期${cutoff ? `（当前为 ${cutoff}）` : "（当前没有其它已排待到场事项，暂无上限）"}；同师傅交叠时段只承接一单。</p>`
          : `<p class="rule-note">如需改期，日期不得晚于已排待到场事项的最晚日期${cutoff ? `（当前为 ${cutoff}）` : "（暂无其它已排事项）"}。</p>`
      }
    </div>`;
  }

  return `${head}</div>`;
}

function renderCancelled(state) {
  const cancelled = state.appointments
    .filter((appointment) => appointment.status === "cancelled")
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
  if (!cancelled.length) return "";
  return `
    <section class="panel cancelled-panel">
      <h2>已取消的预约（时段已让出）</h2>
      <ul class="cancelled-list">
        ${cancelled
          .map((appointment) => {
            const repair = state.repairs.find((item) => item.id === appointment.repairId);
            return `
            <li>
              <span class="chip">${appointment.date} ${slotRangeText(appointment.start)}</span>
              <span>${escapeHtml(appointment.worker)}师傅</span>
              <span class="muted">${repair ? `${escapeHtml(repair.location)}·${escapeHtml(repair.title)}` : "事项已删除"}</span>
              <span class="cancel-reason">缘由：${escapeHtml(appointment.cancelReason || "—")}</span>
            </li>`;
          })
          .join("")}
      </ul>
    </section>
  `;
}

function bindEvents() {
  const state = store.getState();

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      store.setFilter(button.dataset.filter);
      ui.banner = null;
      render();
    });
  });

  const form = document.querySelector("#repair-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.location.trim() || !data.title.trim()) {
        showBanner("error", "位置和问题描述不能为空。");
        render();
        return;
      }
      store.addRepair({
        location: data.location.trim(),
        title: data.title.trim(),
        priority: data.priority,
        cost: data.cost,
        photo: (data.photo || "").trim(),
        note: (data.note || "").trim()
      });
      ui.addDraft = null;
      showBanner("ok", "维修事项已保存，等待排期。");
      render();
    });
    form.addEventListener("input", () => {
      ui.addDraft = Object.fromEntries(new FormData(form).entries());
    });
  }

  const batchForm = document.querySelector("#batch-form");
  if (batchForm) {
    const addRowButton = document.querySelector("#add-row");
    addRowButton.addEventListener("click", () => {
      ensureBatchRows(ui.batchRows.length + 1);
      render();
    });

    document.querySelectorAll("[data-row-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        if (ui.batchRows.length === 1) return;
        ui.batchRows.splice(Number(button.dataset.rowRemove), 1);
        render();
      });
    });

    document.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const row = ui.batchRows[Number(input.dataset.row)];
        row[input.dataset.field] = input.value;
      });
      input.addEventListener("change", () => {
        const row = ui.batchRows[Number(input.dataset.row)];
        row[input.dataset.field] = input.value;
      });
    });

    batchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const result = store.bookBatch(ui.batchRows);
      if (result.ok) {
        ui.batchRows = [];
        ensureBatchRows(1);
        showBanner("ok", `排期成功：本次共提交 ${result.count} 单，师傅时段已锁定。`);
      } else {
        showBanner("error", `整批退回，事项与排期均未改动：\n${result.errors.map((text) => `· ${text}`).join("\n")}`);
      }
      render();
    });
  }

  document.querySelectorAll("[data-arrive]").forEach((button) => {
    button.addEventListener("click", () => {
      const result = store.markArrived(button.dataset.arrive);
      if (result.ok) {
        ui.cancelOpen = null;
        showBanner("ok", "已登记到场，事项转入处理中。");
      } else {
        showBanner("error", result.errors.join("；"));
      }
      render();
    });
  });

  document.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.cancelOpen = ui.cancelOpen === button.dataset.cancel ? null : button.dataset.cancel;
      render();
    });
  });

  document.querySelectorAll("[data-cancel-close]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.cancelOpen = null;
      render();
    });
  });

  document.querySelectorAll("[data-cancel-form]").forEach((formEl) => {
    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const reason = new FormData(formEl).get("reason");
      const result = store.cancelBooking(formEl.dataset.cancelForm, reason);
      if (result.ok) {
        ui.cancelOpen = null;
        showBanner("ok", "预约已取消，该时段已让出。");
      } else {
        showBanner("error", result.errors.join("；"));
      }
      render();
    });
  });

  document.querySelectorAll("[data-reschedule]").forEach((button) => {
    button.addEventListener("click", () => {
      const repairId = button.dataset.reschedule;
      if (ui.rescheduleOpen === repairId) {
        ui.rescheduleOpen = null;
        ui.rescheduleDraft = null;
      } else {
        const appointment = findActiveAppointment(state.appointments, repairId);
        ui.rescheduleOpen = repairId;
        ui.rescheduleDraft = appointment
          ? { date: appointment.date, start: appointment.start, worker: appointment.worker }
          : null;
      }
      render();
    });
  });

  document.querySelectorAll("[data-reschedule-form]").forEach((formEl) => {
    const syncDraft = () => {
      const data = Object.fromEntries(new FormData(formEl).entries());
      ui.rescheduleDraft = data;
    };
    formEl.addEventListener("input", syncDraft);
    formEl.addEventListener("change", syncDraft);
    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(formEl).entries());
      const result = store.rescheduleDoing({ repairId: formEl.dataset.rescheduleForm, ...data });
      if (result.ok) {
        ui.rescheduleOpen = null;
        ui.rescheduleDraft = null;
        showBanner("ok", "改期成功，预约已更新。");
      } else {
        showBanner("error", result.errors.map((text) => `· ${text}`).join("\n"));
      }
      render();
    });
  });

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => {
      const result = store.completeRepair(button.dataset.complete);
      if (result.ok) {
        ui.rescheduleOpen = null;
        showBanner("ok", "事项已完成，上门时段已释放。");
      } else {
        showBanner("error", result.errors.join("；"));
      }
      render();
    });
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      store.deleteRepair(button.dataset.delete);
      showBanner("ok", "事项及其排期记录已删除。");
      render();
    });
  });
}

render();
