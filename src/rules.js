// 规则模块：只负责排期规则与校验，不读写状态、不碰 DOM。

// 一天拆成若干两小时时段
export const SLOTS = [
  { id: "08-10", start: 8, end: 10, label: "08:00 - 10:00" },
  { id: "10-12", start: 10, end: 12, label: "10:00 - 12:00" },
  { id: "12-14", start: 12, end: 14, label: "12:00 - 14:00" },
  { id: "14-16", start: 14, end: 16, label: "14:00 - 16:00" },
  { id: "16-18", start: 16, end: 18, label: "16:00 - 18:00" }
];

export function slotById(slotId) {
  return SLOTS.find((slot) => slot.id === slotId) || null;
}

// 预约占用的时间区间（用于判断交叠）
export function intervalOf(date, slotId) {
  const slot = slotById(slotId);
  if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  return { start: new Date(`${date}T00:00:00`).getTime() + slot.start * 3600000, end: new Date(`${date}T00:00:00`).getTime() + slot.end * 3600000 };
}

export function intervalsOverlap(a, b) {
  return Boolean(a && b) && a.start < b.end && b.start < a.end;
}

function sameWorker(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

// 仍占用师傅时段的预约：已预约 + 已到场/处理中；已完成的不再占用
export function occupiedAppointments(repairs) {
  return repairs.filter((repair) => repair.status === "booked" || repair.status === "doing");
}

// 与某条预约冲突的已存在预约（同一师傅、时段交叠）
export function findWorkerConflict(repairs, date, slotId, worker, ignoreId = null) {
  const target = intervalOf(date, slotId);
  if (!target || !String(worker || "").trim()) return null;
  return (
    occupiedAppointments(repairs).find((repair) => {
      if (ignoreId && repair.id === ignoreId) return false;
      if (!repair.date || !repair.slotId || !sameWorker(repair.worker, worker)) return false;
      const other = intervalOf(repair.date, repair.slotId);
      return intervalsOverlap(target, other);
    }) || null
  );
}

function isFilled(value) {
  return String(value ?? "").trim().length > 0;
}

// 校验一批待提交的预约条目；entries: [{ repairId, date, slotId, worker }]
// 返回 { errors: { [repairId]: "原因" } } —— 只要有错误，整批都必须退回
export function validateBatchEntries(repairs, entries) {
  const errors = {};
  const seen = []; // 本批内已通过字段校验的占用

  for (const entry of entries) {
    const repair = repairs.find((item) => item.id === entry.repairId);
    if (!repair) {
      errors[entry.repairId] = "事项不存在";
      continue;
    }
    if (repair.status !== "todo") {
      errors[entry.repairId] = "只有待处理事项可以预约";
      continue;
    }
    if (!isFilled(entry.date) || !isFilled(entry.slotId) || !isFilled(entry.worker)) {
      errors[entry.repairId] = "请填齐日期、时段和师傅";
      continue;
    }
    if (!slotById(entry.slotId)) {
      errors[entry.repairId] = "时段不存在";
      continue;
    }

    const duplicateInBatch = seen.find(
      (item) => sameWorker(item.worker, entry.worker) && item.date === entry.date && item.slotId === entry.slotId
    );
    if (duplicateInBatch) {
      errors[entry.repairId] = `本批已为「${duplicateInBatch.worker.trim()}」安排该时段，一位师傅同时段只能接一单`;
      continue;
    }

    const conflict = findWorkerConflict(repairs, entry.date, entry.slotId, entry.worker);
    if (conflict) {
      errors[entry.repairId] = `「${entry.worker.trim()}」在 ${entry.date} ${slotById(entry.slotId).label} 已有一单（${conflict.location}·${conflict.title}）`;
      continue;
    }

    seen.push({ repairId: entry.repairId, date: entry.date, slotId: entry.slotId, worker: entry.worker.trim() });
  }

  return { errors, ok: Object.keys(errors).length === 0, accepted: seen };
}

// 处理中事项改期：新时间不得晚于尚未到场（booked）的已排事项
export function validateRescheduleDoing(repairs, repair, date, slotId, worker) {
  if (!isFilled(date) || !isFilled(slotId) || !isFilled(worker)) return "请填齐日期、时段和师傅";
  if (!slotById(slotId)) return "时段不存在";

  const conflict = findWorkerConflict(repairs, date, slotId, worker, repair.id);
  if (conflict) return `「${worker.trim()}」在该时段已有一单（${conflict.location}·${conflict.title}）`;

  const target = intervalOf(date, slotId);
  const upcoming = repairs
    .filter((item) => item.id !== repair.id && item.status === "booked")
    .map((item) => ({ repair: item, time: intervalOf(item.date, item.slotId) }))
    .filter((item) => item.time)
    .sort((a, b) => a.time.start - b.time.start);

  if (upcoming.length && target.start > upcoming[0].time.start) {
    const first = upcoming[0].repair;
    return `处理中事项不能推到已排事项之后：最早的未到场预约是 ${first.date} ${slotById(first.slotId).label}`;
  }
  return null;
}

export function validateCancel(reason) {
  return isFilled(reason) ? null : "取消未到场预约必须写明缘由";
}

export function weekdayOf(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return "";
  return "周" + "日一二三四五六"[new Date(`${date}T00:00:00`).getDay()];
}
