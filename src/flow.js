// 流转模块：维修事项的状态机、批量预约（原子提交）与存档读写。
import { validateBatchEntries, validateCancel, validateRescheduleDoing } from "./rules.js";

export const STATUSES = {
  all: "全部",
  todo: "待处理",
  booked: "已预约",
  doing: "处理中",
  done: "已完成"
};

export const PRIORITIES = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

const STORAGE_KEY = "zfl-14-home-repair-desk";

function todaySeed() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function defaultState() {
  const today = todaySeed();
  return {
    filter: "all",
    drafts: {},
    repairs: [
      {
        id: crypto.randomUUID(),
        location: "厨房",
        title: "水槽下方渗水",
        priority: "high",
        cost: 260,
        status: "todo",
        photo: "",
        note: "先检查软管接口",
        worker: "",
        date: "",
        slotId: "",
        cancelReason: ""
      },
      {
        id: crypto.randomUUID(),
        location: "主卧",
        title: "窗户合页异响",
        priority: "medium",
        cost: 120,
        status: "todo",
        photo: "",
        note: "",
        worker: "",
        date: "",
        slotId: "",
        cancelReason: ""
      }
    ],
    seededDate: today
  };
}

// 兼容旧版（zfl-14-repairs）与缺字段存档
export function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  let state;
  if (saved) {
    try {
      state = JSON.parse(saved);
    } catch {
      state = defaultState();
    }
  } else {
    const legacy = localStorage.getItem("zfl-14-repairs");
    state = legacy ? migrateLegacy(legacy) : defaultState();
  }
  state.filter = STATUSES[state.filter] ? state.filter : "all";
  state.drafts = state.drafts && typeof state.drafts === "object" ? state.drafts : {};
  state.repairs = Array.isArray(state.repairs)
    ? state.repairs.map((repair) => ({
        worker: "",
        date: "",
        slotId: "",
        cancelReason: "",
        photo: "",
        note: "",
        cost: 0,
        ...repair
      }))
    : [];
  return state;
}

function migrateLegacy(raw) {
  try {
    const legacy = JSON.parse(raw);
    return {
      filter: legacy.filter === "doing" || legacy.filter === "todo" || legacy.filter === "done" ? legacy.filter : "all",
      drafts: {},
      repairs: (legacy.repairs || []).map((repair) => ({
        ...repair,
        status: repair.status === "doing" ? "doing" : repair.status === "done" ? "done" : "todo",
        worker: "",
        date: "",
        slotId: "",
        cancelReason: ""
      }))
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function addRepair(state, data) {
  state.repairs.unshift({
    id: crypto.randomUUID(),
    location: data.location.trim(),
    title: data.title.trim(),
    priority: data.priority,
    cost: Number(data.cost || 0),
    status: "todo",
    photo: data.photo.trim(),
    note: data.note.trim(),
    worker: "",
    date: "",
    slotId: "",
    cancelReason: ""
  });
}

// 批量预约：任一条字段不全或撞车，整批退回，事项与草稿保持原样
// 返回 { ok, errors }
export function submitBatch(state, entries) {
  const result = validateBatchEntries(state.repairs, entries);
  if (!result.ok) return { ok: false, errors: result.errors };

  for (const accepted of result.accepted) {
    const repair = state.repairs.find((item) => item.id === accepted.repairId);
    repair.status = "booked";
    repair.date = accepted.date;
    repair.slotId = accepted.slotId;
    repair.worker = accepted.worker;
    repair.cancelReason = "";
    delete state.drafts[accepted.repairId];
  }
  return { ok: true, errors: {} };
}

// 师傅到场：已预约 → 处理中（仍占用该时段）
export function markArrived(state, repairId) {
  const repair = state.repairs.find((item) => item.id === repairId);
  if (repair && repair.status === "booked") repair.status = "doing";
}

// 取消未到场预约：须写明缘由，事项回到待处理并让出时段
// 返回错误字符串或 null
export function cancelBooking(state, repairId, reason) {
  const repair = state.repairs.find((item) => item.id === repairId);
  if (!repair || repair.status !== "booked") return "只有未到场的预约可以取消";
  const error = validateCancel(reason);
  if (error) return error;
  repair.status = "todo";
  repair.cancelReason = reason.trim();
  repair.worker = "";
  repair.date = "";
  repair.slotId = "";
  return null;
}

// 处理中事项改期；不得推到已排（未到场）事项之后，也不能撞师傅时段
export function rescheduleDoing(state, repairId, { date, slotId, worker }) {
  const repair = state.repairs.find((item) => item.id === repairId);
  if (!repair || repair.status !== "doing") return { ok: false, error: "只有处理中事项可以改期" };
  const error = validateRescheduleDoing(state.repairs, repair, date, slotId, worker);
  if (error) return { ok: false, error };
  repair.date = date;
  repair.slotId = slotId;
  repair.worker = worker.trim();
  return { ok: true };
}

export function completeRepair(state, repairId) {
  const repair = state.repairs.find((item) => item.id === repairId);
  if (repair && (repair.status === "doing" || repair.status === "booked")) {
    repair.status = "done";
    // 完成后让出师傅时段
    repair.date = "";
    repair.slotId = "";
    repair.worker = "";
  }
}

export function deleteRepair(state, repairId) {
  state.repairs = state.repairs.filter((repair) => repair.id !== repairId);
  delete state.drafts[repairId];
}

export function saveDraft(state, repairId, draft) {
  state.drafts[repairId] = draft;
}

// 费用合计：未完成事项的预计费用
export function totalOpenCost(repairs) {
  return repairs
    .filter((repair) => repair.status !== "done")
    .reduce((total, repair) => total + Number(repair.cost || 0), 0);
}
